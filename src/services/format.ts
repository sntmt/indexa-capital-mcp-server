/**
 * Shared formatting helpers used by every tool to return either
 * a Markdown string or pretty-printed JSON, plus character-limit
 * truncation to avoid blowing up the model's context window.
 */

import { CHARACTER_LIMIT, ResponseFormat } from "../constants.js";
import { handleApiError } from "./client.js";

/**
 * Formats a number as EUR currency. Indexa accounts are EUR by default.
 */
export function formatEur(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Formats a fractional return (e.g. 0.0384) as a percentage with 2 decimals.
 */
export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `${(value * 100).toFixed(2)}%`;
}

/** "+" for non-negative values, "" otherwise (negatives carry their own "-"). */
export function signPrefix(value: number): string {
  return value >= 0 ? "+" : "";
}

/** Human-readable label for an Indexa product type. */
export function accountTypeLabel(type: string | undefined): string {
  if (type === "mutual") return "Cartera de fondos";
  if (type === "pension") return "Plan de pensiones";
  return type ?? "—";
}

/**
 * Escapes API-provided text for use inside a Markdown table cell, so a
 * stray "|" or newline cannot break the table layout.
 */
export function mdCell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replace(/\|/g, "\\|").replace(/\s*[\r\n]+\s*/g, " ");
}

/**
 * Masks personal identifiers (DNI/NIE, phone numbers) keeping only the
 * last 3 characters, so they are not sent in full to the model.
 */
export function maskSensitive(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= 3) return "***";
  return `***${value.slice(-3)}`;
}

/**
 * Truncates an output string at CHARACTER_LIMIT, appending an explanatory
 * note. Used as a final guard for tools whose responses may be large
 * (performance series, transactions, etc.).
 */
export function enforceCharacterLimit(
  text: string,
  hint?: string
): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) {
    return { text, truncated: false };
  }
  const note =
    `\n\n---\n[Response truncated from ${text.length} to ${CHARACTER_LIMIT} characters. ` +
    `${hint ?? "Narrow the date range or use response_format='json' with pagination."}]`;
  return {
    text: text.slice(0, CHARACTER_LIMIT - note.length) + note,
    truncated: true,
  };
}

/**
 * Pretty JSON helper.
 */
export function toJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

/**
 * Renders the final text content based on the requested format.
 */
export function renderOutput(
  format: ResponseFormat,
  markdown: string,
  jsonValue: unknown,
  truncationHint?: string
): { text: string; truncated: boolean } {
  const raw = format === ResponseFormat.JSON ? toJson(jsonValue) : markdown;
  return enforceCharacterLimit(raw, truncationHint);
}

/**
 * Builds a successful tool result. `structured` is attached as
 * structuredContent only when the text was not truncated, so it never
 * bypasses CHARACTER_LIMIT.
 */
export function toolResult(
  format: ResponseFormat,
  markdown: string,
  structured: Record<string, unknown>,
  truncationHint?: string
) {
  const { text, truncated } = renderOutput(
    format,
    markdown,
    structured,
    truncationHint
  );
  return {
    content: [{ type: "text" as const, text }],
    ...(truncated ? {} : { structuredContent: structured }),
  };
}

/**
 * Builds an error tool result from a ready-made message (string) or from
 * any thrown value.
 */
export function toolError(error: unknown) {
  const text = typeof error === "string" ? error : handleApiError(error);
  return {
    content: [{ type: "text" as const, text }],
    isError: true,
  };
}
