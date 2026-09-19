#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAuthTools } from "./tools/auth.js";
import { registerFirestoreTools } from "./tools/firestore.js";
import { registerStorageTools } from "./tools/storage.js";
import { registerFunctionsTools } from "./tools/functions.js";
import { getProjectId, initFirebase, setCredentialsOverride } from "./firebase.js";
import { parseArgs } from "node:util";

function printUsage(): void {
  console.error(`
🔥 Firebase MCP Server

Usage:
  firebase-mcp [options]

Options:
  --service-account <path>   Path to service account JSON file
  --project-dir <path>       Project dir to search .firebase/service-account.json in
  --help                     Show this help

Credential resolution order:
  1. --service-account argument (explicit path)
  2. .firebase/service-account.json (walked up from --project-dir or cwd)
  3. GOOGLE_APPLICATION_CREDENTIALS env var
  4. FIREBASE_SERVICE_ACCOUNT_PATH env var
`);
}

async function main() {
  // Parse CLI arguments
  const { values } = parseArgs({
    options: {
      "service-account": { type: "string" },
      "project-dir": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: false,
    allowPositionals: true,
  });

  if (values.help) {
    printUsage();
    process.exit(0);
  }

  // Apply overrides before initialization
  const serviceAccount = values["service-account"];
  const projectDir = values["project-dir"];

  if (typeof serviceAccount === "string") {
    setCredentialsOverride({ serviceAccountPath: serviceAccount });
  } else if (typeof projectDir === "string") {
    setCredentialsOverride({ projectDir });
  }

  // Initialize Firebase — fail fast with a clear error
  try {
    initFirebase();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("\nRun with --help for usage information.");
    process.exit(1);
  }

  const projectId = getProjectId() ?? "unknown";

  const server = new McpServer({
    name: `firebase-mcp (${projectId})`,
    version: "1.0.0",
  });

  // Register all tools
  registerAuthTools(server);
  registerFirestoreTools(server);
  registerStorageTools(server);
  registerFunctionsTools(server);

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(`[firebase-mcp] Server running for project: ${projectId}`);
  console.error(`[firebase-mcp] Connected via stdio transport`);
}

main().catch((error) => {
  console.error("[firebase-mcp] Fatal error:", error);
  process.exit(1);
});
