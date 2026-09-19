import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import functions from "@google-cloud/functions";
import { Logging } from "@google-cloud/logging";
import scheduler from "@google-cloud/scheduler";
import { getProjectId, getCredentialsPath } from "../firebase.js";
import { formatError, truncateResult } from "../utils.js";

const { FunctionServiceClient } = functions.v2;
const { CloudSchedulerClient } = scheduler;

// ─── Lazy, credential-sharing GCP clients ─────────────────────
let functionsClient: InstanceType<typeof FunctionServiceClient> | null = null;
let loggingClient: Logging | null = null;
let schedulerClient: InstanceType<typeof CloudSchedulerClient> | null = null;

function clientOptions() {
  return { projectId: getProjectId(), keyFilename: getCredentialsPath() };
}

function getFunctionsClient() {
  if (!functionsClient) functionsClient = new FunctionServiceClient(clientOptions());
  return functionsClient;
}

function getLoggingClient() {
  if (!loggingClient) loggingClient = new Logging(clientOptions());
  return loggingClient;
}

function getSchedulerClient() {
  if (!schedulerClient) schedulerClient = new CloudSchedulerClient(clientOptions());
  return schedulerClient;
}

function requireProjectId(): string {
  const projectId = getProjectId();
  if (!projectId) throw new Error("Project ID is not available from credentials.");
  return projectId;
}

export function registerFunctionsTools(server: McpServer): void {
  // ─── List Functions ─────────────────────────────────────────
  server.registerTool(
    "functions_list",
    {
      description:
        "List Cloud Functions (Gen 2) deployed in the project. Returns name, state, trigger type, entry point, runtime, and URL.",
      inputSchema: {
        region: z
          .string()
          .default("-")
          .describe("Region/location to list (e.g. 'us-central1'). Use '-' for all locations (default)."),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ region }) => {
      try {
        const client = getFunctionsClient();
        const projectId = requireProjectId();
        const parent = client.locationPath(projectId, region);

        const [fns] = await client.listFunctions({ parent });

        const list = fns.map((fn) => ({
          name: fn.name,
          shortName: fn.name?.split("/").pop(),
          state: fn.state,
          environment: fn.environment,
          entryPoint: fn.buildConfig?.entryPoint,
          runtime: fn.buildConfig?.runtime,
          trigger: fn.eventTrigger
            ? { type: "event", eventType: fn.eventTrigger.eventType }
            : { type: "https" },
          url: fn.url ?? fn.serviceConfig?.uri,
          updateTime: fn.updateTime,
        }));

        return {
          content: [{
            type: "text",
            text: truncateResult({
              region,
              functions: list,
              total: list.length,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Get Function Logs (paginated) ──────────────────────────
  server.registerTool(
    "functions_get_logs",
    {
      description:
        "Get Cloud Functions execution logs from Cloud Logging, newest first. Supports pagination via pageToken and optional filtering by function name and severity.",
      inputSchema: {
        functionName: z
          .string()
          .optional()
          .describe("Filter to a single function by its short name (e.g. 'myFunction'). Omit for all functions."),
        severity: z
          .enum(["DEFAULT", "DEBUG", "INFO", "NOTICE", "WARNING", "ERROR", "CRITICAL", "ALERT", "EMERGENCY"])
          .optional()
          .describe("Minimum severity to include (e.g. 'ERROR' returns ERROR and above)."),
        pageSize: z.number().min(1).max(500).default(50).describe("Max log entries to return (1-500)"),
        pageToken: z.string().optional().describe("Opaque page token from a previous response's nextPageToken"),
        freshnessHours: z
          .number()
          .min(1)
          .max(720)
          .default(24)
          .describe("Only include entries from the last N hours (1-720, default 24)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ functionName, severity, pageSize, pageToken, freshnessHours }) => {
      try {
        const logging = getLoggingClient();
        const projectId = requireProjectId();

        const since = new Date(Date.now() - freshnessHours * 3600_000).toISOString();

        // Cloud Functions Gen 2 run on Cloud Run; Gen 1 use cloud_function.
        const filterParts = [
          '(resource.type="cloud_function" OR resource.type="cloud_run_revision")',
          `timestamp>="${since}"`,
        ];
        if (functionName) {
          filterParts.push(
            `(resource.labels.function_name="${functionName}" OR resource.labels.service_name="${functionName}")`
          );
        }
        if (severity) {
          filterParts.push(`severity>=${severity}`);
        }
        const filter = filterParts.join(" AND ");

        const [entries, , apiResponse] = await logging.getEntries({
          filter,
          orderBy: "timestamp desc",
          pageSize,
          pageToken: pageToken || undefined,
          autoPaginate: false,
        });

        const logs = entries.map((entry) => {
          const meta = entry.metadata;
          const labels = meta.resource?.labels as Record<string, string> | undefined;
          return {
            timestamp: meta.timestamp,
            severity: meta.severity,
            function: labels?.function_name ?? labels?.service_name,
            // For text logs entry.data is a string; for structured logs it's an object.
            payload: entry.data,
            trace: meta.trace,
          };
        });

        const nextPageToken =
          (apiResponse as { nextPageToken?: string } | undefined)?.nextPageToken ?? null;

        return {
          content: [{
            type: "text",
            text: truncateResult({
              filter,
              returned: logs.length,
              nextPageToken,
              hasMore: Boolean(nextPageToken),
              logs,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Call Callable Function ─────────────────────────────────
  server.registerTool(
    "functions_call_callable",
    {
      description:
        "Invoke a Firebase HTTPS Callable function. Sends { data } to the callable endpoint and unwraps the { result } envelope. Provide either the full function URL or its short name + region.",
      inputSchema: {
        url: z
          .string()
          .url()
          .optional()
          .describe("Full callable function URL. If omitted, provide 'name' (+ optional 'region')."),
        name: z.string().optional().describe("Short function name (used to build the URL if 'url' is omitted)"),
        region: z.string().default("us-central1").describe("Region used to build the URL from 'name' (default us-central1)"),
        data: z.unknown().optional().describe("Payload passed as the callable 'data' argument"),
      },
    },
    async ({ url, name, region, data }) => {
      try {
        const targetUrl = resolveHttpsUrl(url, name, region);

        const response = await fetch(targetUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ data: data ?? null }),
        });

        const text = await response.text();
        let parsed: unknown = text;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* keep raw text */
        }

        // Callable responses wrap success in { result } and errors in { error }
        const envelope = parsed as { result?: unknown; error?: unknown } | undefined;

        return {
          content: [{
            type: "text",
            text: truncateResult({
              url: targetUrl,
              status: response.status,
              ok: response.ok,
              result: envelope?.result ?? (envelope?.error ? undefined : parsed),
              error: envelope?.error,
            }),
          }],
          isError: !response.ok,
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Run Scheduled Function ─────────────────────────────────
  server.registerTool(
    "functions_run_scheduled",
    {
      description:
        "Force an immediate run of a scheduled Cloud Function by triggering its underlying Cloud Scheduler job. Scheduled (onSchedule) functions cannot be called directly — this triggers the job that fires them.",
      inputSchema: {
        jobName: z
          .string()
          .describe("Scheduler job short name (often 'firebase-schedule-<functionName>-<region>') or full job path"),
        region: z
          .string()
          .default("us-central1")
          .describe("Region of the scheduler job (default us-central1). Ignored if jobName is a full path."),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ jobName, region }) => {
      try {
        const client = getSchedulerClient();
        const projectId = requireProjectId();

        const name = jobName.startsWith("projects/")
          ? jobName
          : client.jobPath(projectId, region, jobName);

        const [job] = await client.runJob({ name });

        return {
          content: [{
            type: "text",
            text: truncateResult({
              message: "Scheduler job triggered successfully",
              name: job.name,
              state: job.state,
              scheduleTime: job.scheduleTime,
              lastAttemptTime: job.lastAttemptTime,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );
}

/**
 * Resolves an HTTPS function URL from either an explicit URL or a name+region.
 */
function resolveHttpsUrl(url: string | undefined, name: string | undefined, region: string): string {
  if (url) return url;
  if (!name) {
    throw new Error("Provide either 'url' or 'name' to identify the function.");
  }
  const projectId = requireProjectId();
  // Gen 2 default URL shape: https://<region>-<project>.cloudfunctions.net/<name>
  return `https://${region}-${projectId}.cloudfunctions.net/${name}`;
}
