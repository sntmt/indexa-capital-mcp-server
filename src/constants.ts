/**
 * Shared constants for the Indexa Capital MCP server.
 */

export const API_BASE_URL = "https://api.indexacapital.com";

/** Maximum response size in characters before truncation. */
export const CHARACTER_LIMIT = 25000;

/** Default request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 30000;

/** Maximum accepted API response body size in bytes (guards memory). */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** Authentication header name expected by the Indexa Capital API. */
export const AUTH_HEADER = "X-AUTH-TOKEN";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json",
}

/** Annotations shared by every tool: all of them are read-only GETs. */
export const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;
