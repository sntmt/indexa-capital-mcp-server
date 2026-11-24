#!/usr/bin/env node
/**
 * Indexa Capital MCP server (read-only).
 *
 * Connects an MCP-compatible client (e.g. Claude Desktop) to the
 * Indexa Capital REST API for monitoring investment accounts. Only
 * GET endpoints are exposed — no transfers, contributions, or
 * withdrawals can be initiated through this server.
 *
 * Authentication: requires INDEXA_API_TOKEN env var. Generate it from
 * the Indexa private area at Configuración de usuario > Aplicaciones.
 */

import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { getApiToken, MISSING_TOKEN_MESSAGE } from "./services/client.js";

import { registerGetMe } from "./tools/get_me.js";
import { registerGetAccount } from "./tools/get_account.js";
import { registerGetPortfolio } from "./tools/get_portfolio.js";
import { registerGetPerformance } from "./tools/get_performance.js";
import { registerGetTransactions } from "./tools/get_transactions.js";
import { registerGetFees } from "./tools/get_fees.js";
import { registerPortfolioSummary } from "./tools/portfolio_summary.js";

// Single source of truth for the version: package.json (shipped with the
// package, one level above dist/).
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const server = new McpServer({
  name: "indexa-capital-mcp-server",
  version,
});

// Register all tools.
registerGetMe(server);
registerGetAccount(server);
registerGetPortfolio(server);
registerGetPerformance(server);
registerGetTransactions(server);
registerGetFees(server);
registerPortfolioSummary(server);

async function main(): Promise<void> {
  // Validate the token is present before connecting transport so we
  // fail fast with a clear error in the client logs.
  if (!getApiToken()) {
    console.error(`ERROR: ${MISSING_TOKEN_MESSAGE}`);
    process.exit(1);
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdio servers MUST log to stderr only (stdout carries MCP frames).
  console.error("indexa-capital-mcp-server running on stdio");
}

main().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
