import { initializeApp, cert, applicationDefault, type App, type ServiceAccount, type Credential } from "firebase-admin/app";
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

// Resolved once on first init, then reused to target other projects.
let resolvedCredentials: ResolvedCredentials | null = null;
let serviceAccountData: ServiceAccount | null = null;

// Active app + its lazily-bound service instances.
let activeApp: App | null = null;
let activeProjectId: string | undefined;
let authInstance: Auth | null = null;
let firestoreInstance: Firestore | null = null;
let storageInstance: Storage | null = null;
let resolvedCredentialsPath: string | null = null;

// Cache of initialized apps, keyed by project ID, so switching back is cheap.
const appsByProject = new Map<string, App>();

/**
 * Builds a fresh Admin credential from the resolved credential source.
 * The same underlying credential (service account key or local gcloud/ADC
 * session) is reused regardless of which project it targets.
 */
function buildCredential(): Credential {
  if (resolvedCredentials?.type === "service-account" && serviceAccountData) {
    return cert(serviceAccountData);
  }
  return applicationDefault();
}

/**
 * Returns a cached Admin app for the given project ID, creating one if needed.
 * Each project gets its own named app so multiple can coexist.
 */
function appForProject(projectId: string): App {
  const existing = appsByProject.get(projectId);
  if (existing) return existing;

  const created = initializeApp(
    { credential: buildCredential(), projectId },
    projectId
  );
  appsByProject.set(projectId, created);
  return created;
}

/**
 * Initializes Firebase Admin SDK with dynamically resolved credentials.
 * Returns the active app; subsequent calls reuse it.
 */
export function initFirebase(): App {
  if (activeApp) return activeApp;

  resolvedCredentials = resolveCredentials();

  let projectId: string | undefined;
  if (resolvedCredentials.type === "service-account") {
    // Google service-account keys use snake_case (project_id); accept both.
    resolvedCredentialsPath = resolvedCredentials.path;
    const raw = JSON.parse(
      readFileSync(resolvedCredentials.path, "utf-8")
    ) as Record<string, unknown>;
    serviceAccountData = raw as ServiceAccount;
    projectId =
      (raw.project_id as string | undefined) ??
      (raw.projectId as string | undefined);
    if (!projectId) {
      throw new Error(
        `Service account file is missing "project_id": ${resolvedCredentials.path}`
      );
    }
  } else {
    // Application Default Credentials (local gcloud session / GCE metadata).
    projectId = resolvedCredentials.projectId;
    if (!projectId) {
      throw new Error(
        `Using the local gcloud session (Application Default Credentials), but no ` +
        `project ID could be determined.\n\n` +
        `Set one of these:\n` +
        `  • gcloud config set project <your-project-id>\n` +
        `  • GOOGLE_CLOUD_PROJECT environment variable`
      );
    }
  }

  activeApp = appForProject(projectId);
  activeProjectId = projectId;

  console.error(`[firebase-mcp] Initialized Firebase for project: ${projectId}`);
  return activeApp;
}

/**
 * Returns the absolute path to the resolved service account key file, if one
 * was used. Returns undefined when authenticating via a local gcloud session /
 * Application Default Credentials — in that case Google Cloud client libraries
 * (Logging, Functions, Scheduler) fall back to ADC automatically.
 */
export function getCredentialsPath(): string | undefined {
  initFirebase();
  return resolvedCredentialsPath ?? undefined;
}

/**
 * Switches the active project at runtime, reusing the same credentials.
 * All subsequent tool calls operate against the new project. Returns the
 * now-active project ID.
 *
 * Note: this only works if the underlying credentials have access to the
 * target project (typically a local gcloud/ADC session, or a service account
 * granted cross-project IAM roles).
 */
export function switchProject(projectId: string): string {
  const target = projectId.trim();
  if (!target) {
    throw new Error("Project ID must not be empty.");
  }

  initFirebase();

  if (target === activeProjectId) {
    return activeProjectId;
  }

  activeApp = appForProject(target);
  activeProjectId = target;

  // Reset bound service instances so getters rebind to the new app.
  authInstance = null;
  firestoreInstance = null;
  storageInstance = null;

  console.error(`[firebase-mcp] Switched active project to: ${target}`);
  return target;
}

/**
 * Lists the Google Cloud projects the active credentials can access, via the
 * Cloud Resource Manager API. Requires the API to be enabled and the
 * credentials to have resourcemanager.projects.list permission.
 */
export async function listAccessibleProjects(): Promise<
  Array<{
    projectId: string;
    name?: string;
    projectNumber?: string;
    state?: string;
    active: boolean;
  }>
> {
  const app = initFirebase();
  const credential = app.options.credential;
  if (!credential) {
    throw new Error("No credential available on the active Firebase app.");
  }

  const { access_token: accessToken } = await credential.getAccessToken();

  const results: Array<{
    projectId: string;
    name?: string;
    projectNumber?: string;
    state?: string;
    active: boolean;
  }> = [];

  let pageToken: string | undefined;
  do {
    const url = new URL("https://cloudresourcemanager.googleapis.com/v1/projects");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(
        `Cloud Resource Manager API returned ${res.status} ${res.statusText}.\n` +
        `${body}\n\n` +
        `Make sure the Cloud Resource Manager API is enabled and the active ` +
        `credentials have permission to list projects.`
      );
    }

    const data = (await res.json()) as {
      projects?: Array<{
        projectId: string;
        name?: string;
        projectNumber?: string;
        lifecycleState?: string;
      }>;
      nextPageToken?: string;
    };

    for (const p of data.projects ?? []) {
      results.push({
        projectId: p.projectId,
        name: p.name,
        projectNumber: p.projectNumber,
        state: p.lifecycleState,
        active: p.projectId === activeProjectId,
      });
    }

    pageToken = data.nextPageToken;
  } while (pageToken);

  return results;
}

/**
 * Returns the Firebase Auth instance for the active project (lazy-bound).
 */
export function getAuthInstance(): Auth {
  if (!authInstance) {
    const app = initFirebase();
    authInstance = getAuth(app);
  }
  return authInstance;
}

/**
 * Returns the Firestore instance for the active project (lazy-bound).
 */
export function getFirestoreInstance(): Firestore {
  if (!firestoreInstance) {
    const app = initFirebase();
    firestoreInstance = getFirestore(app);
  }
  return firestoreInstance;
}

/**
 * Returns the Firebase Storage instance for the active project (lazy-bound).
 */
export function getStorageInstance(): Storage {
  if (!storageInstance) {
    const app = initFirebase();
    storageInstance = getStorage(app);
  }
  return storageInstance;
}

/**
 * Returns the currently active project ID.
 */
export function getProjectId(): string | undefined {
  initFirebase();
  return activeProjectId;
}
