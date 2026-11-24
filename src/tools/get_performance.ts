/**
 * Tool: indexa_get_performance
 *
 * Retrieves historical and projected performance for an Indexa account.
 *
 * The /performance endpoint returns parallel arrays where return[i],
 * period[i], best[i], worst[i], expected[i] correspond to the same
 * point in time. Performance values are returned in base 100 (a value
 * of 105 at index N means +5% cumulative return since the start).
 *
 * Per Indexa support: monthly return = 100*(return[end]/return[start] - 1).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ_ONLY_ANNOTATIONS } from "../constants.js";
import { accountPath, apiGet } from "../services/client.js";
import {
  formatEur,
  formatPercent,
  signPrefix,
  toolError,
  toolResult,
} from "../services/format.js";
import { cumulativeReturn } from "../services/returns.js";
import {
  accountNumberSchema,
  dateRangeError,
  isoDateSchema,
  responseFormatSchema,
} from "../schemas/common.js";

const InputSchema = z
  .object({
    account_number: accountNumberSchema,
    date_from: isoDateSchema
      .optional()
      .describe(
        "Lower bound for the returned series (YYYY-MM-DD). Omit for full history."
      ),
    date_to: isoDateSchema
      .optional()
      .describe(
        "Upper bound for the returned series (YYYY-MM-DD). Omit for latest available."
      ),
    include_projections: z
      .boolean()
      .default(false)
      .describe(
        "Include best/worst/expected projection arrays in the JSON output. " +
          "These can be very large; default false to keep responses small."
      ),
    include_daily: z
      .boolean()
      .default(false)
      .describe(
        "Keep the daily series (index, total_amounts, net_amounts, cash_returns, " +
          "portfolios...). By default they are reduced to one point per month " +
          "(levels at month-end, daily flows summed), which keeps the response " +
          "within limits."
      ),
    response_format: responseFormatSchema,
  })
  .strict();

type Input = z.infer<typeof InputSchema>;

/** Forward-projection series inside `performance`, e.g. "worst_pl". */
const PROJECTION_KEY = /^(best|worst|expected)(_return|_pl)?$/;

interface PerformanceResponse {
  plan_expected_return?: number;
  performance?: {
    period?: string[];
    real?: number[];
    return?: number[];
    benchmark?: number[];
    best?: number[];
    worst?: number[];
    expected?: number[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Normalises any ISO 8601 date string to YYYY-MM-DD.
 *
 * Fast path: if the string starts with a date segment, slice it directly.
 * "2022-01-31T01:00:00+01:00" → "2022-01-31"
 * "2022-01-31"               → "2022-01-31"
 *
 * Fallback: parse with Date and format in UTC (handles edge cases).
 */
function toCalendarDate(isoString: string): string {
  if (/^\d{4}-\d{2}-\d{2}/.test(isoString)) return isoString.slice(0, 10);
  try {
    const d = new Date(isoString);
    return d.toISOString().slice(0, 10);
  } catch {
    return isoString.slice(0, 10); // best effort
  }
}

/**
 * Filters the arrays in `performance` to a date window. Every array is
 * aligned with `period` from its first element; some are shorter (the
 * actual series `real` stops today while projections run 10 years on).
 */
function sliceByDate(
  data: PerformanceResponse,
  from?: string,
  to?: string
): PerformanceResponse {
  const perf = data.performance;
  if (!perf?.period || perf.period.length === 0) return data;

  let startIdx = 0;
  let endIdx = perf.period.length - 1;

  if (from) {
    startIdx = perf.period.findIndex((d) => toCalendarDate(d) >= from);
    if (startIdx === -1) startIdx = perf.period.length;
  }
  if (to) {
    // If no point is on or before `to`, the window is empty.
    endIdx = -1;
    for (let i = perf.period.length - 1; i >= 0; i--) {
      if (toCalendarDate(perf.period[i]) <= to) {
        endIdx = i;
        break;
      }
    }
  }

  if (startIdx === 0 && endIdx === perf.period.length - 1) {
    return data;
  }

  return {
    ...data,
    performance: Object.fromEntries(
      Object.entries(perf).map(([key, value]) => [
        key,
        Array.isArray(value) ? value.slice(startIdx, endIdx + 1) : value,
      ])
    ),
  };
}

/** Daily series in `return` are keyed by "YYYYMMDD". */
function isDailySeries(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => /^\d{8}$/.test(k));
}

/** Daily series that hold per-day flows (P/L), not levels: summed. */
const FLOW_SERIES = new Set(["cash_returns"]);

/** Per-day flow fields inside each `portfolios` entry: summed. */
const PORTFOLIO_FLOW_FIELDS = ["inflows", "outflows", "tax_outflows"];

/**
 * Reduces a "YYYYMMDD"-keyed daily series to one point per month, keyed
 * by the month's last day present (so the latest point is always kept).
 * Levels keep that day's value; flows are summed over the month.
 */
function toMonthly(
  series: Record<string, number>,
  isFlow: boolean,
  from?: string,
  to?: string
): Record<string, number> {
  const fromKey = from?.replace(/-/g, "");
  const toKey = to?.replace(/-/g, "");
  const months = new Map<string, { day: string; value: number }>();
  for (const day of Object.keys(series).sort()) {
    if (fromKey && day < fromKey) continue;
    if (toKey && day > toKey) continue;
    const value = series[day];
    const prev = months.get(day.slice(0, 6));
    months.set(day.slice(0, 6), {
      day,
      value:
        isFlow && prev ? prev.value + (value ?? 0) : value,
    });
  }
  return Object.fromEntries(
    [...months.values()].map(({ day, value }) => [
      day,
      isFlow ? Math.round(value * 100) / 100 : value,
    ])
  );
}

/**
 * `portfolios` is a daily list of account snapshots (newest first). Keep
 * each month's last snapshot, with that month's flows summed into it.
 */
function portfoliosToMonthly(
  list: Record<string, unknown>[],
  from?: string,
  to?: string
): Record<string, unknown>[] {
  const months = new Map<string, Record<string, unknown>>();
  const sorted = [...list].sort((a, b) =>
    String(a.date ?? "").localeCompare(String(b.date ?? ""))
  );
  for (const snap of sorted) {
    const day = typeof snap.date === "string" ? snap.date.slice(0, 10) : "";
    if (!day || (from && day < from) || (to && day > to)) continue;
    const prev = months.get(day.slice(0, 7));
    const merged: Record<string, unknown> = { ...snap };
    for (const field of PORTFOLIO_FLOW_FIELDS) {
      const sum =
        (typeof prev?.[field] === "number" ? (prev[field] as number) : 0) +
        (typeof snap[field] === "number" ? (snap[field] as number) : 0);
      merged[field] = Math.round(sum * 100) / 100;
    }
    months.set(day.slice(0, 7), merged);
  }
  return [...months.values()].reverse(); // newest first, as the API
}

/**
 * The response carries daily series (index, total_amounts, net_amounts,
 * cash_returns, portfolios...) that exceed the response limit after a
 * few months. Reduce them to monthly points unless the caller asks for
 * daily data.
 */
function compactDailySeries(
  data: PerformanceResponse,
  daily: boolean,
  from?: string,
  to?: string
): PerformanceResponse {
  if (daily) return data;
  const compact = (obj: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        isDailySeries(value)
          ? toMonthly(value, FLOW_SERIES.has(key), from, to)
          : value,
      ])
    );

  const result: PerformanceResponse = compact(data);
  if (result.return && typeof result.return === "object") {
    result.return = compact(result.return as Record<string, unknown>);
  }
  if (Array.isArray(result.portfolios)) {
    result.portfolios = portfoliosToMonthly(
      result.portfolios as Record<string, unknown>[],
      from,
      to
    );
  }
  return result;
}

/**
 * Annualised return assuming the series is roughly monthly samples.
 * Uses the ratio of months / 12 as the period.
 */
function annualisedReturn(
  values: number[],
  periods: string[]
): number | null {
  if (values.length < 2 || periods.length < 2) return null;
  const cum = cumulativeReturn(values);
  if (cum === null) return null;

  const start = new Date(toCalendarDate(periods[0]));
  const end = new Date(toCalendarDate(periods[periods.length - 1]));
  const years =
    (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24 * 365.25);
  if (years <= 0) return cum;
  return Math.pow(1 + cum, 1 / years) - 1;
}

function renderMarkdown(data: PerformanceResponse): string {
  const lines: string[] = [];
  lines.push(`# Rentabilidad`);
  lines.push("");

  const perf = data.performance;
  // The API calls the actual series `real`; `return` is kept as fallback.
  const returnSeries = perf?.real ?? perf?.return;
  if (!perf?.period || perf.period.length === 0 || !returnSeries?.length) {
    lines.push("_No hay datos de rentabilidad disponibles._");
    return lines.join("\n");
  }

  // `period` also covers the 10-year projection; keep the actual part.
  const period = perf.period.slice(0, returnSeries.length);
  const { benchmark } = perf;
  const startDate = toCalendarDate(period[0]);
  const endDate = toCalendarDate(period[period.length - 1]);
  const cum = cumulativeReturn(returnSeries);
  const annual = annualisedReturn(returnSeries, period);

  lines.push(`- **Periodo**: ${startDate} → ${endDate}`);
  lines.push(`- **Puntos en la serie**: ${period.length}`);
  lines.push(`- **Rentabilidad acumulada**: ${formatPercent(cum)}`);
  if (annual !== null) {
    lines.push(`- **Rentabilidad anualizada (estimada)**: ${formatPercent(annual)}`);
  }
  const ret = data.return as Record<string, unknown> | undefined;
  if (typeof ret?.money_return === "number") {
    lines.push(
      `- **Rentabilidad ponderada por dinero** (desde el inicio): ${formatPercent(ret.money_return)}`
    );
  }
  if (typeof ret?.pl === "number") {
    lines.push(`- **Ganancia/pérdida**: ${formatEur(ret.pl)}`);
  }
  if (data.plan_expected_return !== undefined) {
    lines.push(
      `- **Rentabilidad esperada del plan**: ${formatPercent(
        data.plan_expected_return
      )}`
    );
  }

  if (benchmark && benchmark.length === returnSeries.length) {
    const benchCum = cumulativeReturn(benchmark);
    if (benchCum !== null) {
      lines.push(`- **Benchmark acumulado**: ${formatPercent(benchCum)}`);
      if (cum !== null) {
        const diff = cum - benchCum;
        lines.push(`- **Alpha vs benchmark**: ${signPrefix(diff)}${formatPercent(diff)}`);
      }
    }
  }
  lines.push("");

  // Sample a handful of points so the user gets a sense of the curve
  // without dumping the whole series.
  const samples = Math.min(8, period.length);
  const step = Math.max(1, Math.floor(period.length / samples));
  lines.push(`## Muestra de la serie (cada ~${step} puntos, base 100)`);
  lines.push("");
  lines.push("| Fecha | Rentabilidad (base 100) | Var. acum. |");
  lines.push("|---|---:|---:|");
  const base = returnSeries[0] ?? 100;
  for (let i = 0; i < period.length; i += step) {
    const v = returnSeries[i];
    const pct = base ? v / base - 1 : 0;
    lines.push(`| ${toCalendarDate(period[i])} | ${v?.toFixed(2) ?? "—"} | ${formatPercent(pct)} |`);
  }
  // Always include the last point
  if ((period.length - 1) % step !== 0) {
    const last = period.length - 1;
    const v = returnSeries[last];
    const pct = base ? v / base - 1 : 0;
    lines.push(`| ${toCalendarDate(period[last])} | ${v?.toFixed(2) ?? "—"} | ${formatPercent(pct)} |`);
  }
  lines.push("");
  lines.push(
    "_Para la serie completa día a día, llama de nuevo con `response_format: 'json'`._"
  );

  return lines.join("\n");
}

export function registerGetPerformance(server: McpServer): void {
  server.registerTool(
    "indexa_get_performance",
    {
      title: "Get Indexa account performance",
      description: `Retrieve the historical performance series for an Indexa account, with optional date filtering and projection data.

Performance values are returned in **base 100** — a value of 105 at index N means +5% cumulative return since the start of the series. Per Indexa support, returns between two points are computed as: \`100 * (return[end] / return[start] - 1)\`.

Args:
  - account_number (string): Indexa account ID
  - date_from (string, optional): Filter the series to start on or after this date (YYYY-MM-DD)
  - date_to (string, optional): Filter the series to end on or before this date (YYYY-MM-DD)
  - include_projections (boolean, default false): Whether to include best/worst/expected forward projections in the JSON output. These can be large; leave off unless explicitly needed.
  - include_daily (boolean, default false): Keep the daily series instead of monthly points (levels at month-end, flows such as cash_returns summed per month).
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

The Markdown format computes and displays:
  - Cumulative (time-weighted) return over the period
  - Annualised return (estimated from the date range)
  - Money-weighted return and P/L since inception
  - Plan expected return (Indexa's own projection)
  - A sampled subset of the curve as a table (~8 points)

Returns:
  For JSON format, the structure is:
  {
    "plan_expected_return": number,         // e.g. 0.042 = +4.2%/year expected
    "performance": {
      "period": ["YYYY-MM-DD...", ...],     // month-ends, actual + 10-year projection
      "real": [number, ...],                // base-100 actual series (aligned with
                                            // period from the start, shorter)
      "expected_return"?, "worst_return"?, "best_return"?: [number, ...],
      "expected_pl"?, "worst_pl"?, "best_pl"?: [number, ...]
                                            // projections, only with include_projections
    },
    "return": {
      "time_return": number,                // time-weighted, since inception
      "money_return": number,               // money-weighted, since inception
      "money_return_annual", "XIRR", "pl", "investment", "inflows", "outflows": number,
      "index", "total_amounts", "net_amounts", "cash_returns": { "YYYYMMDD": number }
                                            // monthly unless include_daily
    },
    "portfolios": [{ "date", "total_amount", "cash_amount", "instruments_amount",
                     "instruments_cost", "inflows", "outflows", ... }],
                                            // one snapshot per month, newest first
    "volatility", "sharpe_ratio": number,
    "drawdowns": { "max_drawdown", "max_drawdown_EUR", ... },
    "history": { "YYYY-MM-DD": number },    // month-end index (1 = start)
    "benchmark": { "YYYY-MM-DD": {...} }
  }

Examples:
  - Use when: "What's my YTD return on Indexa?" -> date_from = first day of year
  - Use when: "How has my account performed since I opened it?" -> no dates
  - Use when: "Compare my returns to the benchmark"
  - Don't use when: The user wants the current value (use indexa_get_portfolio)
    or transaction history (use indexa_get_transactions).

Error handling:
  - 404: account not found or no performance data yet (e.g. just opened).
  - 401/403: token invalid.`,
      inputSchema: InputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: Input) => {
      const rangeError = dateRangeError(params.date_from, params.date_to);
      if (rangeError) return toolError(rangeError);
      try {
        const raw = await apiGet<PerformanceResponse>(
          accountPath(params.account_number, "/performance")
        );

        // Apply client-side date filtering since the API may not support
        // server-side filtering on this endpoint.
        let filtered = sliceByDate(raw, params.date_from, params.date_to);
        filtered = compactDailySeries(
          filtered,
          params.include_daily,
          params.date_from,
          params.date_to
        );

        // Optionally strip projection arrays to keep output compact. The
        // API names them best_return, worst_pl, expected_return, etc.
        if (!params.include_projections && filtered.performance) {
          const rest = Object.fromEntries(
            Object.entries(filtered.performance).filter(
              ([key]) => !PROJECTION_KEY.test(key)
            )
          );
          filtered = { ...filtered, performance: rest };
        }

        return toolResult(
          params.response_format,
          renderMarkdown(filtered),
          filtered,
          "Use date_from and date_to to narrow the time range, or omit projections."
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
