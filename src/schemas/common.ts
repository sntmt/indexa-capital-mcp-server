/**
 * Shared Zod input schemas.
 *
 * Each tool composes these to keep field descriptions consistent
 * and validation rules in one place.
 */

import { z } from "zod";
import { ResponseFormat } from "../constants.js";

/**
 * Indexa account number. Examples seen in the API docs:
 *   - "NK1NUTP1" (mutual)
 *   - "PBKLBYZ5" (mutual)
 *   - "PBKRBYY1" (pension)
 *   - "INDEXA01"
 *
 * The format is uppercase alphanumeric, typically 8 characters, but we
 * keep validation permissive (3-16) since Indexa has not published a
 * strict format spec.
 */
export const accountNumberSchema = z
  .string()
  .min(3, "Account number is too short")
  .max(16, "Account number is too long")
  .regex(/^[A-Z0-9]+$/, "Account number must be uppercase alphanumeric")
  .describe(
    "Indexa account number (account_number field from indexa_get_me). Example: 'NK1NUTP1'."
  );

/**
 * ISO 8601 date (YYYY-MM-DD). Used to filter performance and
 * transaction queries.
 */
export const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be in YYYY-MM-DD format")
  .refine(
    (s) => {
      const d = new Date(`${s}T00:00:00Z`);
      return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
    },
    "Date is not a valid calendar date"
  )
  .describe("Date in YYYY-MM-DD format. Example: '2024-01-15'.");

/**
 * Returns an error message if both bounds are given and date_from is
 * after date_to, otherwise null.
 */
export function dateRangeError(from?: string, to?: string): string | null {
  if (from && to && from > to) {
    return `Error: date_from (${from}) must be on or before date_to (${to}).`;
  }
  return null;
}

export const responseFormatSchema = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe(
    "Output format: 'markdown' for human-readable summary or 'json' for full structured data."
  );
