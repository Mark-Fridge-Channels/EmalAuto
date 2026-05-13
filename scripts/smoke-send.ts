/**
 * Smoke test: send ONE email via Graph App-only, bypassing
 * Postgres / Redis / BullMQ / Notion entirely.
 *
 * Use this to validate:
 *  - tenant_id / client_id / client_secret
 *  - admin-consented `Mail.Send` (Application)
 *  - the sender mailbox UPN is in the tenant and the App can access it
 *
 * Usage:
 *   npx tsx scripts/smoke-send.ts --to alice@example.com \
 *     [--from sender@yourdomain.com] \
 *     [--subject "smoke test"] \
 *     [--body "<p>hello</p>"] \
 *     [--lookup]      # also try to find the sent message in Sent Items
 *
 * If --from is omitted, the first enabled+can_send mailbox in config is used.
 */

import { loadConfig, resolveAppKeyForMailbox } from "../src/config/index.js";
import { acquireGraphTokenForMailbox } from "../src/auth/msal.js";
import { sendMail, findRecentSentMessage } from "../src/graph/mail.service.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : "";
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const to = arg("to");
  if (!to) {
    console.error("missing --to <recipient@example.com>");
    process.exit(2);
  }

  const cfg = loadConfig();
  const defaultSender =
    cfg.mailboxes.find((m) => m.enabled && m.can_send)?.email ?? cfg.mailboxes[0]?.email;
  const from = arg("from") || defaultSender;
  if (!from) {
    console.error("no sender mailbox available (config.mailboxes is empty)");
    process.exit(2);
  }

  const appKey = resolveAppKeyForMailbox(from, cfg);
  if (!appKey) {
    const domain = from.split("@")[1]?.toLowerCase() ?? "";
    console.error(
      `no graph_apps entry for sender domain "${domain}". ` +
        `Add GRAPH_APP_<N>_DOMAIN=${domain} (plus _TENANT_ID/_CLIENT_ID/_CLIENT_SECRET) to .env.`,
    );
    process.exit(2);
  }
  const app = cfg.graph_apps[appKey]!;

  const subject = arg("subject") || `EmalAuto smoke ${new Date().toISOString()}`;
  const bodyHtml =
    arg("body") ||
    `<p>这是一封来自 EmalAuto 的 smoke test 邮件。</p><p>From: <code>${from}</code></p>`;

  console.log("=== EmalAuto smoke-send ===");
  console.log(" app key: ", appKey);
  console.log(" tenant:  ", app.tenant_id);
  console.log(" client:  ", app.client_id);
  console.log(" from:    ", from);
  console.log(" to:      ", to);
  console.log(" subject: ", subject);

  console.log("\n[1/3] acquiring Graph App-only token (per-domain)...");
  const token = await acquireGraphTokenForMailbox(from);
  console.log("       ok, token length =", token.length);

  console.log("\n[2/3] POST /users/{from}/sendMail ...");
  await sendMail({
    fromMailbox: from,
    to: [to],
    subject,
    bodyHtml,
    isHtml: true,
  });
  console.log("       ok (Graph returned 202 Accepted)");

  if (flag("lookup")) {
    console.log("\n[3/3] looking up Sent Items for this message (best-effort)...");
    for (let i = 0; i < 6; i++) {
      const hit = await findRecentSentMessage(from, subject, to, 300);
      if (hit) {
        console.log("       found:", hit);
        break;
      }
      await new Promise((r) => setTimeout(r, 5000));
      console.log(`       not yet, retry ${i + 1}/6 ...`);
    }
  } else {
    console.log("\n[3/3] skipped Sent Items lookup (pass --lookup to enable)");
  }

  console.log("\nDONE. 检查收件人邮箱是否收到了这封邮件。");
}

main().catch((err) => {
  console.error("\nsmoke-send FAILED:", err?.message ?? err);
  if (err?.status) console.error("  http status:", err.status);
  if (err?.code) console.error("  graph code: ", err.code);
  if (err?.details) console.error("  details:    ", JSON.stringify(err.details, null, 2));
  process.exit(1);
});
