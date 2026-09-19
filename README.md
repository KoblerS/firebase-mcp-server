# 🔥 Firebase MCP Server

[![npm version](https://img.shields.io/npm/v/firebase-mcp-server.svg)](https://www.npmjs.com/package/firebase-mcp-server)
[![npm downloads](https://img.shields.io/npm/dm/firebase-mcp-server.svg)](https://www.npmjs.com/package/firebase-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/node/v/firebase-mcp-server.svg)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://www.typescriptlang.org)
[![MCP](https://img.shields.io/badge/MCP-compatible-green.svg)](https://modelcontextprotocol.io)
[![GitHub](https://img.shields.io/github/stars/KoblerS/firebase-mcp-server?style=social)](https://github.com/KoblerS/firebase-mcp-server)

A command-based (stdio) [Model Context Protocol](https://modelcontextprotocol.io) server for **Google Firebase**, providing Auth, Firestore, and Storage tools. Credentials are loaded dynamically from your project directory.

## Features

- **🔐 Auth Tools** — List, get, create, update, delete users & set custom claims
- **📄 Firestore Tools** — Browse collections, read/write/query/delete documents
- **📦 Storage Tools** — List, upload, download, copy, move & delete files, generate signed URLs
- **🔍 Dynamic Credentials** — Automatically finds `.firebase/service-account.json` walking up from cwd
- **📦 npx-ready** — Run directly with `npx firebase-mcp-server`, no global install needed

## Quick Start

### 1. Get your Service Account Key

1. Go to [Firebase Console](https://console.firebase.google.com)
2. Select your project
3. **Project Settings** → **Service Accounts** → **Generate New Private Key**
4. Save the downloaded JSON file

### 2. Place it in your project

```bash
# In your project root
mkdir -p .firebase
mv ~/Downloads/your-project-firebase-adminsdk-*.json .firebase/service-account.json

# IMPORTANT: Add to .gitignore!
echo ".firebase/" >> .gitignore
```

### 3. Configure your MCP Client

#### Claude Code (CLI) ⭐ Recommended

Claude Code sets `cwd` to your project root automatically — credentials are found with zero config:

```bash
claude mcp add firebase -- npx -y firebase-mcp-server
```

That's it. As long as `.firebase/service-account.json` exists in your project, it works.

#### Claude Desktop

Add to `~/.claude/claude_desktop_config.json`:

```jsonc
{
  "mcpServers": {
    "firebase": {
      "command": "npx",
      "args": ["-y", "firebase-mcp-server"]
    }
  }
}
```

Or pass the credentials path explicitly:

```json
{
  "mcpServers": {
    "firebase": {
      "command": "npx",
      "args": ["-y", "firebase-mcp-server", "--service-account", "/path/to/your-project/.firebase/service-account.json"]
    }
  }
}
```

#### Cursor

Add to `.cursor/mcp.json` in your project:

```json
{
  "mcpServers": {
    "firebase": {
      "command": "npx",
      "args": ["-y", "firebase-mcp-server"]
    }
  }
}
```

#### Windsurf

Add to `~/.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "firebase": {
      "command": "npx",
      "args": ["-y", "firebase-mcp-server"]
    }
  }
}
```

## CLI Options

```
firebase-mcp [options]

Options:
  --service-account <path>   Explicit path to service account JSON file
  --project-dir <path>       Directory to search .firebase/service-account.json from
  --help                     Show help
```

## Credential Resolution

The server searches for credentials in this order:

1. **`--service-account <path>`** — Explicit path to the JSON key file
2. **`.firebase/service-account.json`** — Walked up from `--project-dir` or `cwd` (like `.git` lookup)
3. **`GOOGLE_APPLICATION_CREDENTIALS`** — Standard Google Cloud env var
4. **`FIREBASE_SERVICE_ACCOUNT_PATH`** — Custom env var for explicit path

### How does this work with Claude Code?

Claude Code **always starts MCP servers with `cwd` set to your project root**. So if your project looks like this:

```
my-project/
├── .firebase/
│   └── service-account.json   ← found automatically!
├── src/
├── package.json
└── ...
```

…the server finds credentials without any extra config. No `cwd` override needed.

For Claude Desktop, `cwd` is static in the config. Use `--service-account` for a fixed path, or set `cwd` in the JSON config.

## Local Development & Testing

```bash
# Clone and build
git clone <this-repo>
cd firebase-mcp
npm install && npm run build

# Link globally for local testing
npm link

# Test CLI
firebase-mcp --help
firebase-mcp --service-account /path/to/key.json    # explicit
firebase-mcp --project-dir /path/to/your/project     # search from dir
firebase-mcp                                          # search from cwd

# Test with Claude Code (from your Firebase project dir)
cd /path/to/your-project
claude mcp add firebase -- firebase-mcp

# Or test with MCP Inspector
npx @modelcontextprotocol/inspector firebase-mcp
```

## Available Tools

### 🔐 Auth Tools

| Tool                              | Description                            |
| --------------------------------- | -------------------------------------- |
| `firebase_auth_get_user`          | Get user by UID or email               |
| `firebase_auth_list_users`        | List users (paginated, max 1000)       |
| `firebase_auth_create_user`       | Create a new user                      |
| `firebase_auth_update_user`       | Update user properties                 |
| `firebase_auth_delete_user`       | Delete a user                          |
| `firebase_auth_set_custom_claims` | Set custom claims (roles, permissions) |

### 📄 Firestore Tools

| Tool                         | Description                                |
| ---------------------------- | ------------------------------------------ |
| `firestore_list_collections` | List top-level or sub-collections          |
| `firestore_get_document`     | Get a single document by path              |
| `firestore_list_documents`   | List documents in a collection (paginated) |
| `firestore_query_documents`  | Query with where/orderBy/limit filters     |
| `firestore_count_documents`  | Count documents (with optional filters)    |
| `firestore_set_document`     | Create or overwrite a document             |
| `firestore_update_document`  | Update specific fields                     |
| `firestore_delete_document`  | Delete a document                          |

### 📦 Storage Tools

| Tool                        | Description                                                         |
| --------------------------- | ------------------------------------------------------------------- |
| `storage_list_files`        | List files & folders in a bucket (with prefix filter, pagination)   |
| `storage_get_file_metadata` | Get file metadata (size, content type, timestamps, custom metadata) |
| `storage_get_download_url`  | Get a Firebase download URL for a file                              |
| `storage_get_signed_url`    | Generate a temporary signed URL (read or write, up to 7 days)       |
| `storage_upload`            | Upload text or base64 content to a file                             |
| `storage_download`          | Download a file as text or base64 (max 10MB)                        |
| `storage_delete_file`       | Delete a file                                                       |
| `storage_copy_file`         | Copy a file (same or different bucket)                              |
| `storage_move_file`         | Move / rename a file                                                |

## Usage Examples

Once connected, you can ask your AI assistant things like:

> "List all collections in Firestore"

> "Show me the first 10 users in Firebase Auth"

> "Query the 'orders' collection for all orders where status == 'pending'"

> "Get the document at users/abc123"

> "Count how many documents are in the 'products' collection"

> "Update the user with UID xyz to set displayName to 'John Doe'"

> "List all files in the 'images/' folder in Storage"

> "Upload this JSON to storage at 'exports/data.json'"

> "Generate a signed download URL for 'reports/monthly.pdf' that expires in 24 hours"

### Special Field Values (for writes)

The Firestore write tools support special field values:

```json
// Server timestamp
{ "_type": "serverTimestamp" }

// Increment a number field
{ "_type": "increment", "value": 5 }

// Add to an array field
{ "_type": "arrayUnion", "elements": ["tag1", "tag2"] }

// Remove from an array field
{ "_type": "arrayRemove", "elements": ["tag1"] }

// Delete a field
{ "_type": "delete" }
```

## Project Structure

```
firebase-mcp/
├── src/
│   ├── index.ts          # CLI entry point with arg parsing
│   ├── firebase.ts       # Dynamic credential loading & Firebase init
│   ├── utils.ts          # Serialization & helpers
│   └── tools/
│       ├── auth.ts       # Firebase Auth tools (6)
│       ├── firestore.ts  # Firestore tools (8)
│       └── storage.ts    # Firebase Storage tools (9)
├── dist/                 # Compiled output (after build)
├── package.json
├── tsconfig.json
└── README.md
```

## Security Notes

⚠️ **Never commit your service account key to git!**

Make sure `.firebase/` is in your `.gitignore`:

```gitignore
.firebase/
```

The service account key grants **full admin access** to your Firebase project. Treat it like a password.

## Large Outputs

Read operations that return more than ~50,000 characters (large collections, big documents, long file listings) are **not truncated**. Instead, the full result is written to a temporary file and the tool returns a short message telling the LLM the output was too large, along with the `filePath` to read:

```json
{
  "status": "output_too_large",
  "message": "The output was too large to return inline. The full result has been written to the file below. Read that file to access the complete data.",
  "filePath": "/tmp/firebase-mcp-XXXXXX/output.json",
  "totalChars": 128034,
  "threshold": 50000
}
```

This keeps the model's context from being flooded while ensuring no data is lost — the client can read the file on demand. Temp files are written to the OS temp directory (`os.tmpdir()`).

## License

MIT
