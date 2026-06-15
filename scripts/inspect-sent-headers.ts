/**
 * Inspect List-Unsubscribe / DKIM headers on a sent message (debug deliverability).
 *
 * Usage:
 *   npx tsx scripts/inspect-sent-headers.ts --from kacey@domain.com --subject "Mark a quick question"
 */
import { loadConfig } from "../src/config/index.js";
import { findRecentSentMessage } from "../src/graph/mail.service.js";
import { getMessageInternetHeaders } from "../src/graph/mail.service.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  loadConfig();
  const from = arg("--from");
  const subject = arg("--subject");
  const to = arg("--to");
  if (!from || !subject) {
    console.error("Usage: npx tsx scripts/inspect-sent-headers.ts --from MAILBOX --subject SUBJECT [--to RECIPIENT]");
    process.exit(1);
  }

  const hit = await findRecentSentMessage(from, subject, to ?? "", 7 * 24 * 3600);
  if (!hit) {
    console.error("No sent message found (subject + to must match exactly).");
    process.exit(2);
  }

  console.log("graphMessageId:", hit.graphMessageId);
  console.log("sentAt:", hit.sentAt);

  const headers = await getMessageInternetHeaders(from, hit.graphMessageId);
  const names = [
    "list-unsubscribe",
    "list-unsubscribe-post",
    "dkim-signature",
    "authentication-results",
  ];
  for (const want of names) {
    const h = headers.find((x) => x.name.toLowerCase() === want);
    console.log(`\n=== ${want} ===`);
    console.log(h?.value ?? "(missing)");
  }

  const dkim = headers.find((h) => h.name.toLowerCase() === "dkim-signature")?.value ?? "";
  const coversListUnsub = /\bh=.*list-unsubscribe/i.test(dkim);
  console.log("\n=== DKIM covers List-Unsubscribe? ===");
  console.log(coversListUnsub ? "yes" : "NO — Gmail one-click chip likely hidden (RFC 8058)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
