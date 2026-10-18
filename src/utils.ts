import {
  Timestamp,
  GeoPoint,
  DocumentReference,
  FieldValue,
  type DocumentData,
} from "firebase-admin/firestore";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Converts a Firestore document's data to a JSON-safe format.
 * Handles Timestamps, GeoPoints, DocumentReferences, Buffers, etc.
 */
export function serializeFirestoreData(data: DocumentData): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    result[key] = serializeValue(value);
  }

  return result;
}

function serializeValue(value: unknown): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (value instanceof Timestamp) {
    return {
      _type: "Timestamp",
      seconds: value.seconds,
      nanoseconds: value.nanoseconds,
      iso: value.toDate().toISOString(),
    };
  }

  if (value instanceof GeoPoint) {
    return {
      _type: "GeoPoint",
      latitude: value.latitude,
      longitude: value.longitude,
    };
  }

  if (value instanceof DocumentReference) {
    return {
      _type: "DocumentReference",
      path: value.path,
    };
  }

  if (Buffer.isBuffer(value)) {
    return {
      _type: "Buffer",
      length: value.length,
      preview: value.toString("base64").slice(0, 100),
    };
  }

  if (Array.isArray(value)) {
    return value.map(serializeValue);
  }

  if (typeof value === "object" && value !== null) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      obj[k] = serializeValue(v);
    }
    return obj;
  }

  return value;
}

/**
 * Deserializes special types back from JSON input for write operations.
 * Supports: Timestamp, GeoPoint, serverTimestamp, delete, increment, arrayUnion, arrayRemove
 */
export function deserializeValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(deserializeValue);
  }

  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;

    // Handle special _type markers
    if (obj._type === "Timestamp" && typeof obj.seconds === "number") {
      return new Timestamp(obj.seconds as number, (obj.nanoseconds as number) ?? 0);
    }

    if (obj._type === "GeoPoint" && typeof obj.latitude === "number" && typeof obj.longitude === "number") {
      return new GeoPoint(obj.latitude as number, obj.longitude as number);
    }

    if (obj._type === "serverTimestamp") {
      return FieldValue.serverTimestamp();
    }

    if (obj._type === "delete") {
      return FieldValue.delete();
    }

    if (obj._type === "increment" && typeof obj.value === "number") {
      return FieldValue.increment(obj.value as number);
    }

    if (obj._type === "arrayUnion" && Array.isArray(obj.elements)) {
      return FieldValue.arrayUnion(...(obj.elements as unknown[]));
    }

    if (obj._type === "arrayRemove" && Array.isArray(obj.elements)) {
      return FieldValue.arrayRemove(...(obj.elements as unknown[]));
    }

    // Recursively process plain objects
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deserializeValue(v);
    }
    return result;
  }

  return value;
}

/** Fallback max output size (in characters) when nothing else is configured. */
export const DEFAULT_MAX_OUTPUT_SIZE = 25000;

/** Env var used to deduce the max output size when no CLI value is given. */
export const MAX_OUTPUT_ENV_VAR = "FIREBASE_MCP_MAX_OUTPUT";

// Module-level configured value; resolved once at startup, overridable at runtime.
let maxOutputSize = resolveMaxOutputSize();

/**
 * Deduces the max output size (in characters) from the environment, falling
 * back to the built-in default. Resolution order:
 *   1. FIREBASE_MCP_MAX_OUTPUT env var (positive integer)
 *   2. DEFAULT_MAX_OUTPUT_SIZE
 */
export function resolveMaxOutputSize(): number {
  const raw = process.env[MAX_OUTPUT_ENV_VAR];
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
    console.error(
      `[firebase-mcp] Ignoring invalid ${MAX_OUTPUT_ENV_VAR}="${raw}" ` +
      `(must be a positive number); using default ${DEFAULT_MAX_OUTPUT_SIZE}.`
    );
  }
  return DEFAULT_MAX_OUTPUT_SIZE;
}

/**
 * Sets the max output size (in characters) used by truncateResult.
 * Values <= 0 are ignored. Intended to be called once at startup from CLI args.
 */
export function setMaxOutputSize(size: number): void {
  if (Number.isFinite(size) && size > 0) {
    maxOutputSize = Math.floor(size);
  }
}

/** Returns the currently configured max output size (in characters). */
export function getMaxOutputSize(): number {
  return maxOutputSize;
}

/**
 * Serializes a result for return to the LLM. If the JSON is small enough it is
 * returned inline. If it exceeds the configured max output size, the full
 * result is written to a temp file instead and a short message pointing at that
 * file is returned, so the LLM's context is not flooded but no data is lost.
 *
 * The threshold defaults to the configured value (see getMaxOutputSize), which
 * is deduced from the FIREBASE_MCP_MAX_OUTPUT env var or the --max-output-size
 * CLI flag. Pass `maxLength` to override per call.
 */
export function truncateResult(data: unknown, maxLength: number = maxOutputSize): string {
  const json = JSON.stringify(data, null, 2);
  if (json.length <= maxLength) return json;

  const filePath = writeLargeOutput(json);
  return JSON.stringify(
    {
      status: "output_too_large",
      message:
        "The output was too large to return inline. The full result has been " +
        "written to the file below. Read that file to access the complete data.",
      filePath,
      totalChars: json.length,
      threshold: maxLength,
    },
    null,
    2
  );
}

/**
 * Writes large output to a temp file and returns its absolute path.
 * Each call uses a fresh temp directory to avoid collisions.
 */
export function writeLargeOutput(content: string, extension = "json"): string {
  const dir = mkdtempSync(join(tmpdir(), "firebase-mcp-"));
  const filePath = join(dir, `output.${extension}`);
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

/**
 * Formats an error into a consistent error response.
 */
export function formatError(error: unknown): string {
  if (error instanceof Error) {
    return `Error: ${error.message}`;
  }
  return `Error: ${String(error)}`;
}
