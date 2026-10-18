import { initializeApp, cert, applicationDefault, getApps, type App, type ServiceAccount } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { getStorage, type Storage } from "firebase-admin/storage";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

const SERVICE_ACCOUNT_PATH = ".firebase/service-account.json";

/**
 * Resolved credential source: either an explicit service account key file,
 * or Application Default Credentials (which include the local `gcloud`
 * session created via `gcloud auth application-default login`).
 */
type ResolvedCredentials =
  | { type: "service-account"; path: string }
  | { type: "adc"; projectId: string | undefined };

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
 * Returns the path to the local gcloud Application Default Credentials file
 * if it exists. This file is created by `gcloud auth application-default login`.
 *
 * Honors CLOUDSDK_CONFIG, then falls back to the OS-specific default location.
 */
function findGcloudAdcFile(): string | null {
  const configDir =
    process.env.CLOUDSDK_CONFIG ??
    (process.platform === "win32"
      ? join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "gcloud")
      : join(homedir(), ".config", "gcloud"));

  const adcPath = join(configDir, "application_default_credentials.json");
  return existsSync(adcPath) ? adcPath : null;
}

/**
 * Best-effort resolution of the active project ID for ADC/gcloud usage.
 * Order: env vars → quota_project_id in the ADC file → `gcloud config get-value project`.
 */
function resolveAdcProjectId(adcPath: string): string | undefined {
  const envProject =
    process.env.GOOGLE_CLOUD_PROJECT ??
    process.env.GCLOUD_PROJECT ??
    process.env.GCP_PROJECT;
  if (envProject) {
    return envProject;
  }

  // Try the quota_project_id stored in the ADC file.
  try {
    const adc = JSON.parse(readFileSync(adcPath, "utf-8")) as {
      quota_project_id?: string;
    };
    if (adc.quota_project_id) {
      return adc.quota_project_id;
    }
  } catch {
    // ignore malformed ADC file; fall through to gcloud CLI
  }

  // Fall back to the active gcloud project configuration.
  try {
    const project = execFileSync(
      process.platform === "win32" ? "gcloud.cmd" : "gcloud",
      ["config", "get-value", "project"],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim();
    if (project && project !== "(unset)") {
      return project;
    }
  } catch {
    // gcloud not installed or no active config; project ID stays undefined
  }

  return undefined;
}

/**
 * Resolves Firebase credentials in this order:
 * 1. Explicit --service-account CLI argument
 * 2. .firebase/service-account.json walked up from --project-dir or cwd
 * 3. GOOGLE_APPLICATION_CREDENTIALS env var
 * 4. FIREBASE_SERVICE_ACCOUNT_PATH env var
 * 5. Local gcloud session (Application Default Credentials) as fallback
 */
function resolveCredentials(): ResolvedCredentials {
  // 1. Explicit path via CLI
  if (overrideServiceAccountPath) {
    const resolved = resolve(overrideServiceAccountPath);
    if (existsSync(resolved)) {
      console.error(`[firebase-mcp] Using --service-account: ${resolved}`);
      return { type: "service-account", path: resolved };
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
    return { type: "service-account", path: fromDir };
  }

  // 3. Standard Google env var
  const googleCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (googleCreds && existsSync(googleCreds)) {
    console.error(`[firebase-mcp] Using GOOGLE_APPLICATION_CREDENTIALS: ${googleCreds}`);
    return { type: "service-account", path: googleCreds };
  }

  // 4. Custom env var
  const customPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (customPath && existsSync(customPath)) {
    console.error(`[firebase-mcp] Using FIREBASE_SERVICE_ACCOUNT_PATH: ${customPath}`);
    return { type: "service-account", path: customPath };
  }

  // 5. Local gcloud session (Application Default Credentials) fallback
  const adcPath = findGcloudAdcFile();
  if (adcPath) {
    const projectId = resolveAdcProjectId(adcPath);
    console.error(
      `[firebase-mcp] Using local gcloud session (ADC): ${adcPath}` +
      (projectId ? ` (project: ${projectId})` : "")
    );
    return { type: "adc", projectId };
  }

  throw new Error(
    `Firebase credentials not found.\n\n` +
    `Searched for .firebase/service-account.json starting from:\n` +
    `  ${searchDir}\n\n` +
    `Fix it with one of these:\n` +
    `  1. Create .firebase/service-account.json in your project root\n` +
    `  2. Pass --service-account /path/to/key.json\n` +
    `  3. Pass --project-dir /path/to/your/project\n` +
    `  4. Set GOOGLE_APPLICATION_CREDENTIALS environment variable\n` +
    `  5. Log in with the gcloud CLI: gcloud auth application-default login\n\n` +
    `To get a service account key:\n` +
    `  → Firebase Console → Project Settings → Service Accounts → Generate New Private Key`
  );
}

let app: App | null = null;
let authInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;
let storageInstance: Storage | null = null;

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

  const credentials = resolveCredentials();

  if (credentials.type === "service-account") {
    const serviceAccount = JSON.parse(
      readFileSync(credentials.path, "utf-8")
    ) as ServiceAccount;

    app = initializeApp({
      credential: cert(serviceAccount),
      projectId: serviceAccount.projectId as string,
    });

    console.error(`[firebase-mcp] Initialized Firebase for project: ${serviceAccount.projectId}`);
    return app;
  }

  // Application Default Credentials (local gcloud session / GCE metadata).
  if (!credentials.projectId) {
    throw new Error(
      `Using the local gcloud session (Application Default Credentials), but no ` +
      `project ID could be determined.\n\n` +
      `Set one of these:\n` +
      `  • gcloud config set project <your-project-id>\n` +
      `  • GOOGLE_CLOUD_PROJECT environment variable`
    );
  }

  app = initializeApp({
    credential: applicationDefault(),
    projectId: credentials.projectId,
  });

  console.error(`[firebase-mcp] Initialized Firebase for project: ${credentials.projectId}`);
  return app;
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
