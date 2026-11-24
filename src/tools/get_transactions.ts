/**
 * Tool: indexa_get_transactions
 *
 * Retrieves the transaction history for an Indexa account: contributions,
 * withdrawals, fund subscriptions and redemptions, fees charged, etc.
 *
 * Indexa splits the history across two endpoints:
 *   - GET /accounts/{account_number}/cash-transactions       (money in/out)
 *   - GET /accounts/{account_number}/instrument-transactions (fund buys/sells)
 * Both are fetched in parallel and merged. The exact response shapes are
 * not documented in the public RAML, so we read them permissively and
 * tag each transaction with the endpoint it came from.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AxiosError } from "axios";
import { z } from "zod";
import { READ_ONLY_ANNOTATIONS } from "../constants.js";
import { accountPath, apiGet } from "../services/client.js";
import {
  formatEur,
  maskIdsInText,
  mdCell,
  toolError,
  toolResult,
} from "../services/format.js";
import {
  accountNumberSchema,
  dateRangeError,
  isoDateSchema,
  responseFormatSchema,
} from "../schemas/common.js";

const InputSchema = z
  .object({
    account_number: accountNumberSchema,
    date_from: isoDateSchema.optional(),
    date_to: isoDateSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(50)
      .describe("Maximum transactions to return after date filtering."),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe("Number of transactions to skip after date filtering."),
    response_format: responseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

type TransactionSource = "cash" | "instrument";

const SOURCE_PATHS: Record<TransactionSource, string> = {
  cash: "/cash-transactions",
  instrument: "/instrument-transactions",
};

interface Transaction {
  source?: TransactionSource;
  date?: string;
  operation_date?: string;
  value_date?: string;
  amount?: number | string;
  type?: string;
  operation_type?: string;
  description?: string;
  comments?: string;
  instrument?: { name?: string; identifier?: string };
  [key: string]: unknown;
}

type TransactionsResponse =
  | Transaction[]
  | { transactions?: Transaction[]; data?: Transaction[] };

function extractTransactions(
  raw: TransactionsResponse
): Transaction[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw.transactions)) return raw.transactions;
    if (Array.isArray(raw.data)) return raw.data;
  }
  return [];
}

/**
 * Compact view of a transaction. The raw API objects embed the full
 * fund description, order and PDF metadata (~2 KB each), which blows
 * past the response limit for any account with a few months of history.
 */
interface TransactionSummary {
  source: TransactionSource;
  date?: string;
  value_date?: string;
  type?: string;
  amount?: number;
  description?: string;
  instrument?: { name?: string; identifier?: string };
  titles?: number;
  price?: number;
  reference?: string;
}

function toDate(value: unknown): string | undefined {
  return typeof value === "string" ? value.slice(0, 10) : undefined;
}

function toNumber(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && !Number.isNaN(n) ? n : undefined;
}

function summarize(
  tx: Transaction,
  source: TransactionSource
): TransactionSummary {
  const text = tx.description ?? tx.comments;
  return {
    source,
    date: toDate(tx.date ?? tx.operation_date ?? tx.value_date),
    value_date: toDate(tx.value_date),
    type: tx.operation_type ?? tx.type,
    amount: toNumber(tx.amount),
    // Transfer concepts can carry the holder's full DNI/NIE.
    description: typeof text === "string" ? maskIdsInText(text) : undefined,
    instrument: tx.instrument
      ? { name: tx.instrument.name, identifier: tx.instrument.identifier }
      : undefined,
    titles: toNumber(tx.titles),
    price: toNumber(tx.price),
    reference: typeof tx.reference === "string" ? tx.reference : undefined,
  };
}

/**
 * Fetches one transaction endpoint. A 404 means the endpoint does not
 * apply to this account type, so it yields an empty list instead of
 * failing the whole call.
 */
async function fetchSource(
  accountNumber: string,
  source: TransactionSource
): Promise<TransactionSummary[]> {
  try {
    const raw = await apiGet<TransactionsResponse>(
      accountPath(accountNumber, SOURCE_PATHS[source])
    );
    return extractTransactions(raw).map((tx) => summarize(tx, source));
  } catch (error) {
    if (error instanceof AxiosError && error.response?.status === 404) {
      return [];
    }
    throw error;
  }
}

function inDateWindow(
  d: string | undefined,
  from?: string,
  to?: string
): boolean {
  if (d === undefined) return !from && !to;
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function renderMarkdown(
  txs: TransactionSummary[],
  total: number,
  offset: number
): string {
  const lines: string[] = [];
  lines.push(`# Movimientos`);
  lines.push("");
  lines.push(
    `Mostrando ${txs.length} de ${total} (offset ${offset}).`
  );
  lines.push("");
  if (txs.length === 0) {
    lines.push("_No hay movimientos en el rango seleccionado._");
    return lines.join("\n");
  }

  lines.push("| Fecha | Origen | Tipo | Importe | Concepto |");
  lines.push("|---|---|---|---:|---|");
  for (const tx of txs) {
    const origin = tx.source === "cash" ? "Efectivo" : "Fondos";
    const amt = formatEur(tx.amount);
    const desc =
      tx.description ??
      tx.instrument?.name ??
      (tx.instrument?.identifier ? `ISIN ${tx.instrument.identifier}` : undefined);
    lines.push(
      `| ${mdCell(tx.date)} | ${origin} | ${mdCell(tx.type)} | ${amt} | ${mdCell(desc)} |`
    );
  }

  return lines.join("\n");
}

export function registerGetTransactions(server: McpServer): void {
  server.registerTool(
    "indexa_get_transactions",
    {
      title: "Get Indexa account transactions",
      description: `Retrieve the transaction history for an Indexa account: contributions (aportaciones), withdrawals (retiradas), fund subscriptions and redemptions, dividend reinvestments, fees charged, etc.

Use this for questions about money in/out of the account or specific operations on a date.

Args:
  - account_number (string): Indexa account ID
  - date_from (string, optional): Lower date bound (YYYY-MM-DD)
  - date_to (string, optional): Upper date bound (YYYY-MM-DD)
  - limit (number, default 50, max 500): Maximum transactions to return
  - offset (number, default 0): Pagination offset
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns:
  For JSON format, a compact array of transactions merged from the
  cash-transactions and instrument-transactions endpoints, newest first:
  {
    "source": "cash" | "instrument",     // endpoint the entry came from
    "date": "YYYY-MM-DD",
    "value_date"?: "YYYY-MM-DD",
    "type": string,                      // Indexa operation type, e.g. "TRANSFERENCIA SEPA",
                                         // "SUSCRIPCIÓN FONDOS INVERSIÓN", "COMISIONES CUSTODIA"
    "amount": number,                    // EUR; cash entries are signed (negative = out of account)
    "description"?: string,              // concept, with DNI/NIE masked
    "instrument"?: {
      "name": string,
      "identifier": string                // ISIN, or DGS code for pension funds
    },
    "titles"?: number,                   // units bought/sold (instrument entries)
    "price"?: number,
    "reference"?: string
  }

  Each fund purchase appears twice: once as the cash debit
  ("OPERACIONES VALORES", source "cash") and once as the subscription
  (source "instrument"). Don't add both when totalling.

Examples:
  - Use when: "How much have I contributed to Indexa this year?"
  - Use when: "Show my last 20 movements on account NK1NUTP1"
  - Use when: "Did I get charged fees in March?"

Error handling:
  - 404: endpoint not available for this account type or status.
  - 401/403: token invalid.

Note: Date filtering and pagination are applied client-side after the
API responds. For very active accounts with many years of history, narrow
the date_from / date_to window to keep responses fast and within limits.`,
      inputSchema: InputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: Input) => {
      const rangeError = dateRangeError(params.date_from, params.date_to);
      if (rangeError) return toolError(rangeError);
      try {
        const [cash, instrument] = await Promise.all([
          fetchSource(params.account_number, "cash"),
          fetchSource(params.account_number, "instrument"),
        ]);
        // Newest first; undated entries sink to the end.
        const all = [...cash, ...instrument].sort((a, b) =>
          (b.date ?? "").localeCompare(a.date ?? "")
        );

        const filtered = all.filter((tx) =>
          inDateWindow(tx.date, params.date_from, params.date_to)
        );
        const total = filtered.length;
        const page = filtered.slice(
          params.offset,
          params.offset + params.limit
        );
        const hasMore = total > params.offset + page.length;

        const structured = {
          total,
          count: page.length,
          offset: params.offset,
          transactions: page,
          has_more: hasMore,
          ...(hasMore ? { next_offset: params.offset + page.length } : {}),
        };

        const markdown = renderMarkdown(page, total, params.offset);
        return toolResult(
          params.response_format,
          markdown,
          structured,
          "Narrow the date_from / date_to window or reduce 'limit'."
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
