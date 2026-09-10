/**
 * Christmas Pilot Scheme A orchestrator.
 *
 * Default is dry-run (no History writes). Pass --write to create/update rows.
 *
 * Examples:
 *   npm run campaign:orchestrate
 *   npm run campaign:orchestrate -- --limit=20
 *   npm run campaign:orchestrate -- --write --fresh
 *   npm run campaign:orchestrate -- --write --limit=5
 *   npm run campaign:orchestrate -- --write --client=6c192adb...
 */
import { orchestrateChristmasPilot } from "../src/campaign/orchestrate.js";
import { loadConfig, printConfigSummary } from "../src/config/index.js";

function argFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1] && !process.argv[idx + 1]!.startsWith("--")) {
    return process.argv[idx + 1];
  }
  return undefined;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  printConfigSummary(cfg);

  const write = argFlag("write");
  const fresh = argFlag("fresh");
  const limitRaw = argValue("limit");
  const limitClients = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
  const clientIds = process.argv
    .filter((a) => a.startsWith("--client="))
    .map((a) => a.slice("--client=".length))
    .filter(Boolean);

  console.log(
    JSON.stringify(
      {
        mode: write ? "WRITE" : "DRY_RUN",
        freshWrite: write && fresh,
        limitClients: limitClients ?? null,
        clientIds: clientIds.length ? clientIds : null,
        window: `${cfg.notion.campaign.window_start} → ${cfg.notion.campaign.window_end}`,
        dailyCap: cfg.notion.campaign.daily_cap_per_mailbox,
      },
      null,
      2,
    ),
  );

  const result = await orchestrateChristmasPilot({
    dryRun: !write,
    freshWrite: write && fresh,
    limitClients: Number.isFinite(limitClients) ? limitClients : undefined,
    clientIds: clientIds.length ? clientIds : undefined,
  });

  const peakByDay: Record<string, number> = {};
  for (const [ymd, byBox] of Object.entries(result.report.dailyLoad)) {
    peakByDay[ymd] = Object.values(byBox).reduce((a, b) => a + b, 0);
  }

  console.log(
    JSON.stringify(
      {
        mailboxCount: result.mailboxCount,
        clientCount: result.clientCount,
        instanceCount: result.instanceCount,
        scheduledOk: result.report.scheduled.filter((s) => !s.atRisk).length,
        atRisk: result.report.atRiskCount,
        skippedNoKp: result.report.skippedNoKp,
        businessDays: result.report.businessDays,
        sendsPerDay: peakByDay,
        writeSummary: result.writeSummary,
        sample: result.sample,
      },
      null,
      2,
    ),
  );

  if (result.writeSummary.errors > 0) {
    console.error(`completed with ${result.writeSummary.errors} write errors`);
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
