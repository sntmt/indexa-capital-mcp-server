/**
 * Tool: indexa_portfolio_summary
 *
 * Convenience tool that combines /users/me + /portfolio + /performance
 * for every active account into a single response.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { READ_ONLY_ANNOTATIONS } from "../constants.js";
import { accountPath, apiGet, handleApiError } from "../services/client.js";
import {
  accountTypeLabel,
  formatEur,
  formatPercent,
  signPrefix,
  toolError,
  toolResult,
} from "../services/format.js";
import {
  parsePortfolio,
  type RawPortfolioResponse,
} from "../services/portfolio_parse.js";
import { cumulativeReturn } from "../services/returns.js";
import { responseFormatSchema } from "../schemas/common.js";

const InputSchema = z.object({ response_format: responseFormatSchema }).strict();
type Input = z.infer<typeof InputSchema>;

interface MeAccount { account_number: string; status: string; type: "mutual" | "pension" }
interface MePartial { email?: string; name?: string; surname?: string; accounts?: MeAccount[] }
interface PerformanceStub {
  performance?: { period?: string[]; return?: number[] };
  plan_expected_return?: number;
}

interface AccountSummary {
  account_number: string;
  type: "mutual" | "pension";
  status: string;
  total_value: number | null;
  cash: number | null;
  unrealized_pl: number | null;
  cumulative_return: number | null;
  plan_expected_return: number | null;
  error?: string;
}

async function summariseAccount(account: MeAccount): Promise<AccountSummary> {
  const summary: AccountSummary = {
    account_number: account.account_number,
    type: account.type,
    status: account.status,
    total_value: null,
    cash: null,
    unrealized_pl: null,
    cumulative_return: null,
    plan_expected_return: null,
  };

  if (account.status !== "active") return summary;

  const [portfolioRes, perfRes] = await Promise.allSettled([
    apiGet<RawPortfolioResponse>(accountPath(account.account_number, "/portfolio")),
    apiGet<PerformanceStub>(accountPath(account.account_number, "/performance")),
  ]);

  // The portfolio is required (it feeds the totals); performance is
  // optional, but its failure is still reported instead of swallowed.
  const errors: string[] = [];
  if (portfolioRes.status === "fulfilled") {
    const parsed = parsePortfolio(portfolioRes.value);
    summary.total_value = parsed.totalAmount;
    summary.cash = parsed.cashAmount;
    summary.unrealized_pl = parsed.unrealizedPL;
  } else {
    errors.push(`portfolio: ${handleApiError(portfolioRes.reason)}`);
  }

  if (perfRes.status === "fulfilled") {
    const perf = perfRes.value;
    summary.cumulative_return = cumulativeReturn(perf?.performance?.return);
    summary.plan_expected_return = perf?.plan_expected_return ?? null;
  } else {
    errors.push(`performance: ${handleApiError(perfRes.reason)}`);
  }

  if (errors.length > 0) summary.error = errors.join(" | ");
  return summary;
}

/** Active accounts whose portfolio could not be fetched (missing from totals). */
function incompleteAccounts(summaries: AccountSummary[]): AccountSummary[] {
  return summaries.filter((a) => a.status === "active" && a.total_value === null);
}

function renderMarkdown(user: MePartial, summaries: AccountSummary[]): string {
  const name = [user.name, user.surname].filter(Boolean).join(" ") || user.email || "usuario";
  const lines: string[] = [];
  lines.push(`# Resumen Indexa Capital — ${name}`);
  lines.push("");

  if (summaries.length === 0) {
    lines.push("_No hay cuentas asociadas a este usuario._");
    return lines.join("\n");
  }

  const totalValue = summaries.reduce((s, a) => s + (a.total_value ?? 0), 0);
  const totalPL = summaries.reduce((s, a) => s + (a.unrealized_pl ?? 0), 0);
  lines.push(`- **Patrimonio total en Indexa**: ${formatEur(totalValue)}`);
  lines.push(`- **P/L latente total**: ${signPrefix(totalPL)}${formatEur(totalPL)}`);
  lines.push(`- **Cuentas**: ${summaries.length}`);
  const incomplete = incompleteAccounts(summaries);
  if (incomplete.length > 0) {
    lines.push(
      `- ⚠️ **Totales incompletos**: no se pudo obtener la cartera de ${incomplete
        .map((a) => a.account_number)
        .join(", ")}.`
    );
  }
  lines.push("");

  for (const a of summaries) {
    lines.push(`## ${a.account_number} — ${accountTypeLabel(a.type)}`);
    lines.push(`- **Estado**: ${a.status}`);
    if (a.status !== "active") {
      lines.push(`- _Sin datos de cartera (cuenta no activa)._`);
      lines.push("");
      continue;
    }
    if (a.error) lines.push(`- ⚠️ ${a.error}`);
    if (a.total_value === null) {
      lines.push("");
      continue;
    }
    lines.push(`- **Valor total**: ${formatEur(a.total_value)}`);
    if (a.cash !== null && a.cash > 0) lines.push(`- **Efectivo**: ${formatEur(a.cash)}`);
    lines.push(
      `- **P/L latente**: ${signPrefix(a.unrealized_pl ?? 0)}${formatEur(a.unrealized_pl)}`
    );
    if (a.cumulative_return !== null) {
      lines.push(`- **Rentabilidad acumulada**: ${formatPercent(a.cumulative_return)}`);
    }
    if (a.plan_expected_return !== null) {
      lines.push(`- **Rentabilidad esperada**: ${formatPercent(a.plan_expected_return)}`);
    }
    lines.push("");
  }

  lines.push("---");
  lines.push("_Para más detalle: `indexa_get_portfolio` (composición), `indexa_get_performance` (histórico), `indexa_get_transactions` (movimientos)._");
  return lines.join("\n");
}

export function registerPortfolioSummary(server: McpServer): void {
  server.registerTool(
    "indexa_portfolio_summary",
    {
      title: "Indexa portfolio overview (all accounts)",
      description: `Convenience tool that returns a one-shot overview of ALL the user's Indexa Capital accounts: total wealth, per-account value, cash, unrealized P/L and cumulative return. Calls /users/me then /portfolio and /performance for each active account in parallel.

Use this as the FIRST tool for open-ended questions like "how are my Indexa investments doing?" or "give me an overview of my Indexa". Only use account-specific tools when the user specifies one account or aspect (composition, transactions, fees).

Args:
  - response_format ('markdown' | 'json'): Output format (default: 'markdown')

Returns JSON:
  { "user": { email, name, surname },
    "accounts": [{ account_number, type, status, total_value, cash,
                   unrealized_pl, cumulative_return, plan_expected_return, error? }],
    "totals": { total_value, unrealized_pl, account_count,
                incomplete_accounts: string[] } }   // active accounts missing from totals`,
      inputSchema: InputSchema,
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (params: Input) => {
      try {
        const me = await apiGet<MePartial>("/users/me");
        const accounts = me.accounts ?? [];
        const summaries = await Promise.all(accounts.map(summariseAccount));

        const totals = {
          total_value: summaries.reduce((s, a) => s + (a.total_value ?? 0), 0),
          unrealized_pl: summaries.reduce((s, a) => s + (a.unrealized_pl ?? 0), 0),
          account_count: summaries.length,
          incomplete_accounts: incompleteAccounts(summaries).map(
            (a) => a.account_number
          ),
        };
        const structured = {
          user: { email: me.email, name: me.name, surname: me.surname },
          accounts: summaries,
          totals,
        };

        return toolResult(
          params.response_format,
          renderMarkdown(me, summaries),
          structured
        );
      } catch (error) {
        return toolError(error);
      }
    }
  );
}
