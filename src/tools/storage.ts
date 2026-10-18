import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getStorageInstance,
  resolveBucketName,
  getActiveBucket,
  getDefaultBucketName,
  switchBucket,
  listStorageBuckets,
} from "../firebase.js";
import { getDownloadURL } from "firebase-admin/storage";
import { formatError, truncateResult } from "../utils.js";

function getBucket(bucketName?: string) {
  const storage = getStorageInstance();
  // Priority: explicit per-call bucket → active bucket → project default.
  return storage.bucket(resolveBucketName(bucketName));
}

export function registerStorageTools(server: McpServer): void {
  // ─── Current Bucket ─────────────────────────────────────────
  server.registerTool(
    "storage_current_bucket",
    {
      description: "Show the Storage bucket operations currently target by default",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const active = getActiveBucket();
        const def = getDefaultBucketName();
        return {
          content: [{
            type: "text",
            text: truncateResult({
              activeBucket: resolveBucketName(),
              isDefault: !active,
              defaultBucket: def,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── List Buckets ───────────────────────────────────────────
  server.registerTool(
    "storage_list_buckets",
    {
      description:
        "List the Cloud Storage buckets in the active project (via the GCS API). " +
        "Requires the credentials to have storage.buckets.list permission.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
      },
    },
    async () => {
      try {
        const buckets = await listStorageBuckets();
        return {
          content: [{
            type: "text",
            text: truncateResult({
              buckets,
              total: buckets.length,
              activeBucket: resolveBucketName(),
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Switch Bucket ──────────────────────────────────────────
  server.registerTool(
    "storage_switch_bucket",
    {
      description:
        "Set the default bucket for subsequent Storage operations. Pass an empty " +
        "bucket to reset back to the project default. Individual tool calls can " +
        "still override this with their own `bucket` argument.",
      inputSchema: {
        bucket: z
          .string()
          .optional()
          .describe("Bucket name to make active. Omit/empty to reset to the project default."),
      },
    },
    async ({ bucket }) => {
      try {
        const previous = resolveBucketName();
        const active = switchBucket(bucket);
        return {
          content: [{
            type: "text",
            text: truncateResult({
              status: "switched",
              previousBucket: previous,
              activeBucket: active,
              isDefault: !getActiveBucket(),
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── List Files ─────────────────────────────────────────────
  server.registerTool(
    "storage_list_files",
    {
      description: "List files in a Firebase Storage bucket. Supports prefix (folder) filtering and pagination.",
      inputSchema: {
        prefix: z.string().optional().describe("Filter by path prefix / folder (e.g. 'images/', 'users/uid123/')"),
        delimiter: z.string().default("/").describe("Delimiter for folder-like listing (default '/')"),
        maxResults: z.number().min(1).max(1000).default(100).describe("Max files to return (1-1000)"),
        pageToken: z.string().optional().describe("Page token for pagination"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ prefix, delimiter, maxResults, pageToken, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);

        const [files, , apiResponse] = await bucket.getFiles({
          prefix: prefix || undefined,
          delimiter,
          maxResults,
          pageToken: pageToken || undefined,
          autoPaginate: false,
        });

        const fileList = files.map((file) => ({
          name: file.name,
          size: file.metadata.size,
          contentType: file.metadata.contentType,
          updated: file.metadata.updated,
          created: file.metadata.timeCreated,
        }));

        const prefixes = (apiResponse as { prefixes?: string[] })?.prefixes ?? [];

        return {
          content: [{
            type: "text",
            text: truncateResult({
              bucket: bucket.name,
              prefix: prefix ?? "(root)",
              files: fileList,
              folders: prefixes,
              returned: fileList.length,
              hasMore: !!(apiResponse as { nextPageToken?: string })?.nextPageToken,
              nextPageToken: (apiResponse as { nextPageToken?: string })?.nextPageToken ?? null,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Get File Metadata ──────────────────────────────────────
  server.registerTool(
    "storage_get_file_metadata",
    {
      description: "Get metadata of a file in Firebase Storage (size, content type, timestamps, custom metadata)",
      inputSchema: {
        path: z.string().describe("File path in the bucket (e.g. 'images/photo.jpg')"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ path, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);
        const file = bucket.file(path);
        const [metadata] = await file.getMetadata();

        return {
          content: [{
            type: "text",
            text: truncateResult({
              name: metadata.name,
              bucket: metadata.bucket,
              size: metadata.size,
              contentType: metadata.contentType,
              contentEncoding: metadata.contentEncoding,
              md5Hash: metadata.md5Hash,
              crc32c: metadata.crc32c,
              timeCreated: metadata.timeCreated,
              updated: metadata.updated,
              generation: metadata.generation,
              metageneration: metadata.metageneration,
              customMetadata: metadata.metadata ?? {},
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Get Download URL ───────────────────────────────────────
  server.registerTool(
    "storage_get_download_url",
    {
      description: "Get a download URL for a file in Firebase Storage",
      inputSchema: {
        path: z.string().describe("File path in the bucket (e.g. 'images/photo.jpg')"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ path, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);
        const file = bucket.file(path);
        const url = await getDownloadURL(file);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ path, url }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Get Signed URL ─────────────────────────────────────────
  server.registerTool(
    "storage_get_signed_url",
    {
      description: "Generate a temporary signed URL for a file (read or write). Useful for sharing or uploading.",
      inputSchema: {
        path: z.string().describe("File path in the bucket"),
        action: z.enum(["read", "write"]).default("read").describe("URL action: 'read' for download, 'write' for upload"),
        expiresInMinutes: z.number().min(1).max(10080).default(60).describe("URL expiry in minutes (max 7 days = 10080)"),
        contentType: z.string().optional().describe("Content type for write URLs (e.g. 'image/png')"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ path, action, expiresInMinutes, contentType, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);
        const file = bucket.file(path);

        const [url] = await file.getSignedUrl({
          action,
          expires: Date.now() + expiresInMinutes * 60 * 1000,
          contentType: contentType || undefined,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              path,
              action,
              url,
              expiresIn: `${expiresInMinutes} minutes`,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Upload from Text/Base64 ────────────────────────────────
  server.registerTool(
    "storage_upload",
    {
      description: "Upload content to Firebase Storage. Supports plain text or base64-encoded data.",
      inputSchema: {
        path: z.string().describe("Destination file path in the bucket (e.g. 'documents/report.txt')"),
        content: z.string().describe("File content: plain text or base64-encoded string"),
        contentType: z.string().default("application/octet-stream").describe("MIME type (e.g. 'text/plain', 'image/png', 'application/json')"),
        isBase64: z.boolean().default(false).describe("Set to true if content is base64-encoded"),
        metadata: z.record(z.string()).optional().describe("Custom metadata key-value pairs"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
    },
    async ({ path, content, contentType, isBase64, metadata, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);
        const file = bucket.file(path);

        const buffer = isBase64
          ? Buffer.from(content, "base64")
          : Buffer.from(content, "utf-8");

        await file.save(buffer, {
          contentType,
          metadata: metadata ? { metadata } : undefined,
        });

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "File uploaded successfully",
              path,
              bucket: bucket.name,
              size: buffer.length,
              contentType,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Download as Text/Base64 ────────────────────────────────
  server.registerTool(
    "storage_download",
    {
      description: "Download a file from Firebase Storage. Returns content as text (for text files) or base64 (for binary). Max 10MB.",
      inputSchema: {
        path: z.string().describe("File path in the bucket (e.g. 'documents/report.txt')"),
        asBase64: z.boolean().default(false).describe("Return content as base64 (use for binary files)"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
      annotations: {
        readOnlyHint: true,
      },
    },
    async ({ path, asBase64, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);
        const file = bucket.file(path);

        const [metadata] = await file.getMetadata();
        const size = Number(metadata.size ?? 0);
        const maxSize = 10 * 1024 * 1024; // 10MB

        if (size > maxSize) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: `File too large (${(size / 1024 / 1024).toFixed(1)}MB). Max download size is 10MB. Use storage_get_signed_url instead.`,
                path,
                size,
              }),
            }],
            isError: true,
          };
        }

        const [buffer] = await file.download();

        const content = asBase64
          ? buffer.toString("base64")
          : buffer.toString("utf-8");

        return {
          content: [{
            type: "text",
            text: truncateResult({
              path,
              contentType: metadata.contentType,
              size,
              encoding: asBase64 ? "base64" : "utf-8",
              content,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Delete File ────────────────────────────────────────────
  server.registerTool(
    "storage_delete_file",
    {
      description: "Delete a file from Firebase Storage",
      inputSchema: {
        path: z.string().describe("File path to delete (e.g. 'images/old-photo.jpg')"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
      annotations: {
        destructiveHint: true,
      },
    },
    async ({ path, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);
        await bucket.file(path).delete();

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "File deleted successfully",
              path,
              bucket: bucket.name,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Copy File ──────────────────────────────────────────────
  server.registerTool(
    "storage_copy_file",
    {
      description: "Copy a file within Firebase Storage (same or different bucket)",
      inputSchema: {
        sourcePath: z.string().describe("Source file path"),
        destinationPath: z.string().describe("Destination file path"),
        sourceBucket: z.string().optional().describe("Source bucket (default: project default)"),
        destinationBucket: z.string().optional().describe("Destination bucket (default: same as source)"),
      },
    },
    async ({ sourcePath, destinationPath, sourceBucket, destinationBucket }) => {
      try {
        const srcBucket = getBucket(sourceBucket);
        const destBucket = destinationBucket ? getBucket(destinationBucket) : srcBucket;

        await srcBucket.file(sourcePath).copy(destBucket.file(destinationPath));

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "File copied successfully",
              from: { bucket: srcBucket.name, path: sourcePath },
              to: { bucket: destBucket.name, path: destinationPath },
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );

  // ─── Move File ──────────────────────────────────────────────
  server.registerTool(
    "storage_move_file",
    {
      description: "Move (rename) a file in Firebase Storage. Copies to new path and deletes the original.",
      inputSchema: {
        sourcePath: z.string().describe("Current file path"),
        destinationPath: z.string().describe("New file path"),
        bucket: z.string().optional().describe("Bucket name (default: project default bucket)"),
      },
    },
    async ({ sourcePath, destinationPath, bucket: bucketName }) => {
      try {
        const bucket = getBucket(bucketName);
        const sourceFile = bucket.file(sourcePath);

        await sourceFile.move(destinationPath);

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              message: "File moved successfully",
              from: sourcePath,
              to: destinationPath,
              bucket: bucket.name,
            }),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text", text: formatError(error) }], isError: true };
      }
    }
  );
}
