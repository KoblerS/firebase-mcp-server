import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getProjectId,
  switchProject,
  listAccessibleProjects,
} from "../firebase.js";
import { formatError, truncateResult } from "../utils.js";

export function registerProjectTools(server: McpServer): void {
  // ─── Current Project ────────────────────────────────────────
  server.registerTool(
    "firebase_current_project",
    {
      description: "Show the project ID the server is currently operating against",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        return {
          content: [{
            type: "text",
            text: truncateResult({ activeProject: getProjectId() ?? null }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── List Projects ──────────────────────────────────────────
  server.registerTool(
    "firebase_list_projects",
    {
      description:
        "List the Google Cloud projects the current credentials can access " +
        "(via the Cloud Resource Manager API). Requires the API to be enabled " +
        "and the credentials to have permission to list projects.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const projects = await listAccessibleProjects();
        return {
          content: [{
            type: "text",
            text: truncateResult({
              projects,
              total: projects.length,
              activeProject: getProjectId() ?? null,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Switch Project ─────────────────────────────────────────
  server.registerTool(
    "firebase_switch_project",
    {
      description:
        "Switch the active project at runtime. All subsequent tool calls " +
        "operate against the new project. Reuses the same credentials, so the " +
        "target project must be accessible by them (typical for a local " +
        "gcloud/ADC session or a cross-project service account).",
      inputSchema: {
        projectId: z.string().min(1).describe("The project ID to switch to"),
      },
    },
    async ({ projectId }) => {
      try {
        const previous = getProjectId();
        const active = switchProject(projectId);
        return {
          content: [{
            type: "text",
            text: truncateResult({
              status: "switched",
              previousProject: previous ?? null,
              activeProject: active,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );
}
