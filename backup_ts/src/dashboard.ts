import chalk from "chalk";
import { loadAuthFile } from "./auth.js";

interface DashboardAccount {
  access_token?: string;
  user_email?: string;
  client_id?: string;
  rateLimitResetTime?: number;
  accounts?: DashboardAccount[];
  [k: string]: unknown;
}

export function renderDashboard(): void {
    const authFile = loadAuthFile();
    const providers = authFile.providers || {};
    console.log(chalk.bold.green("\n=== MUSE CONNECTOR DASHBOARD ==="));
    console.log(chalk.dim("Routing Strategy: MULTI"));
    console.log("");
    const header = `${"ID".padEnd(4)} | ${"Provider".padEnd(10)} | ${"Account (Client ID / Email)".padEnd(30)} | ${"Status"}`;
    console.log(chalk.bold(header));
    console.log("-".repeat(header.length + 10));
    let idCounter = 0;
    for (const [providerName, providerData] of Object.entries(providers)) {
        const accounts = (providerData as DashboardAccount).accounts || [providerData as DashboardAccount];
        for (const acc of accounts) {
            if (!acc.access_token)
                continue;
            const idStr = idCounter.toString().padEnd(4);
            const provStr = providerName.padEnd(10);
            const identStr = (acc.user_email || acc.client_id || "Unknown").padEnd(30);
            const isExhausted = Date.now() < (acc.rateLimitResetTime || 0);
            const statusStr = isExhausted ? chalk.bold.red("RATE LIMITED") : chalk.bold.green("ACTIVE");
            console.log(`${idStr} | ${provStr} | ${identStr} | ${statusStr}`);
            idCounter++;
        }
    }
    if (idCounter === 0) {
        console.log(chalk.dim("No accounts found. Use `muse login --provider <name>` to add accounts."));
    }
    console.log("");
}
