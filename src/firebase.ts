import { initializeApp, cert, getApps, type App, type ServiceAccount } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

const SERVICE_ACCOUNT_PATH = ".firebase/service-account.json";

// CLI / programmatic overrides
let overrideServiceAccountPath: string | undefined;
let overrideProjectDir: string | undefined;

/**
 * Set credential overrides from CLI args or programmatic usage.
 */
export function setCredentialsOverride(opts: {
  serviceAccountPath?: string;
  projectDir?: string;
}): void {
  overrideServiceAccountPath = opts.serviceAccountPath;
  overrideProjectDir = opts.projectDir;
}

/**
 * Searches for .firebase/service-account.json starting from `startDir`
 * and walking up the directory tree (like how .git is found).
 */
function findServiceAccount(startDir: string): string | null {
  let current = resolve(startDir);

  while (true) {
    const candidate = join(current, SERVICE_ACCOUNT_PATH);
    if (existsSync(candidate)) {
      return candidate;
    }

    const parent = dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return null;
}

/**
 * Resolves the service account credentials path in this order:
 * 1. Explicit --service-account CLI argument
 * 2. .firebase/service-account.json walked up from --project-dir or cwd
 * 3. GOOGLE_APPLICATION_CREDENTIALS env var
 * 4. FIREBASE_SERVICE_ACCOUNT_PATH env var
 */
function resolveCredentialsPath(): string {
  // 1. Explicit path via CLI
  if (overrideServiceAccountPath) {
    const resolved = resolve(overrideServiceAccountPath);
    if (existsSync(resolved)) {
      console.error(`[firebase-mcp] Using --service-account: ${resolved}`);
      return resolved;
    }
    throw new Error(
      `Service account file not found: ${resolved}\n` +
      `  (provided via --service-account)`
    );
  }

  // 2. Walk up from project dir (--project-dir or cwd)
  const searchDir = overrideProjectDir ? resolve(overrideProjectDir) : process.cwd();
  const fromDir = findServiceAccount(searchDir);
  if (fromDir) {
    console.error(`[firebase-mcp] Found credentials at: ${fromDir}`);
    return fromDir;
  }

  // 3. Standard Google env var
  const googleCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googleCreds && existsSync(googleCreds)) {
    console.error(`[firebase-mcp] Using GOOGLE_APPLICATION_CREDENTIALS: ${googleCreds}`);
    return googleCreds;
  }

  // 4. Custom env var
  const customPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (customPath && existsSync(customPath)) {
    console.error(`[firebase-mcp] Using FIREBASE_SERVICE_ACCOUNT_PATH: ${customPath}`);
    return customPath;
  }

  throw new Error(
    `Firebase credentials not found.\n\n` +
    `Searched for .firebase/service-account.json starting from:\n` +
    `  ${searchDir}\n\n` +
    `Fix it with one of these:\n` +
    `  1. Create .firebase/service-account.json in your project root\n` +
    `  2. Pass --service-account /path/to/key.json\n` +
    `  3. Pass --project-dir /path/to/your/project\n` +
    `  4. Set GOOGLE_APPLICATION_CREDENTIALS environment variable\n\n` +
    `To get a service account key:\n` +
    `  → Firebase Console → Project Settings → Service Accounts → Generate New Private Key`
  );
}

let app: App | null = null;
let authInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;
let storageInstance: Storage | null = null;
let resolvedCredentialsPath: string | null = null;

/**
 * Initializes Firebase Admin SDK with dynamically resolved credentials.
 * Returns the same instance on subsequent calls.
 */
export function initFirebase(): App {
  if (app) return app;

  const existingApps = getApps();
  if (existingApps.length > 0) {
    app = existingApps[0]!;
    return app;
  }

  const credentialsPath = resolveCredentialsPath();
  resolvedCredentialsPath = credentialsPath;
  const serviceAccount = JSON.parse(
    readFileSync(credentialsPath, "utf-8")
  ) as ServiceAccount;

  app = initializeApp({
    credential: cert(serviceAccount),
    projectId: serviceAccount.projectId as string,
  });

  console.error(`[firebase-mcp] Initialized Firebase for project: ${serviceAccount.projectId}`);
  return app;
}

/**
 * Returns the absolute path to the resolved service account key file.
 * Used to configure Google Cloud client libraries (Logging, Functions,
 * Scheduler) with the same credentials as the Admin SDK.
 */
export function getCredentialsPath(): string {
  initFirebase();
  if (!resolvedCredentialsPath) {
    throw new Error("Credentials path is not available (Firebase not initialized).");
  }
  return resolvedCredentialsPath;
}

/**
 * Returns the Firebase Auth instance (lazy-initialized).
 */
export function getAuthInstance(): Auth {
  if (!authInstance) {
    initFirebase();
    authInstance = getAuth();
  }
  return authInstance;
}

/**
 * Returns the Firestore instance (lazy-initialized).
 */
export function getFirestoreInstance(): Firestore {
  if (!firestoreInstance) {
    initFirebase();
    firestoreInstance = getFirestore();
  }
  return firestoreInstance;
}

/**
 * Returns the Firebase Storage instance (lazy-initialized).
 */
export function getStorageInstance(): Storage {
  if (!storageInstance) {
    initFirebase();
    storageInstance = getStorage();
  }
  return storageInstance;
}

/**
 * Returns the project ID from the initialized app.
 */
export function getProjectId(): string | undefined {
  const firebaseApp = initFirebase();
  return firebaseApp.options.projectId ?? undefined;
}
