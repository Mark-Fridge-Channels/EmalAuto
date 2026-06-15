import assert from "node:assert/strict";
import test from "node:test";

import {
  ensureComplianceFooter,
  ensureOutboundMailBody,
  ensureSenderSignature,
  signatureNameFromMailbox,
} from "../src/services/mail-signature.service.js";
import {
  buildListUnsubscribeHeaders,
  canIssueListUnsubscribeHeaders,
  createUnsubscribeToken,
  verifyUnsubscribeToken,
} from "../src/services/list-unsubscribe.service.js";

const FOOTER = "Not the right time? Reply 'stop' and I won't write again.";

test("signatureNameFromMailbox uses mailbox prefix with title case", () => {
  assert.equal(signatureNameFromMailbox("billy@fcconnect.co"), "Billy");
  assert.equal(signatureNameFromMailbox("ella.smith@fridgepartners.com"), "Ella Smith");
});

test("ensureSenderSignature appends plain text signature only when missing", () => {
  assert.equal(ensureSenderSignature("Hello", "kacey@example.com", false), "Hello\n\nKacey");
  assert.equal(ensureSenderSignature("Hello\n\nKacey", "kacey@example.com", false), "Hello\n\nKacey");
});

test("ensureSenderSignature inserts HTML signature before quoted reply content", () => {
  const body = `<p>Hello</p><hr><blockquote><p>Old Molly signature in quoted mail</p></blockquote>`;
  assert.equal(
    ensureSenderSignature(body, "molly@example.com", true),
    `<p>Hello</p><p>Molly</p><hr><blockquote><p>Old Molly signature in quoted mail</p></blockquote>`,
  );
});

test("ensureComplianceFooter appends opt-out text after signature block", () => {
  const body = "Hello\n\nBilly";
  assert.equal(
    ensureComplianceFooter(body, FOOTER, false),
    `Hello\n\nBilly\n\n${FOOTER}`,
  );
});

test("ensureOutboundMailBody adds signature then footer", () => {
  assert.equal(
    ensureOutboundMailBody("Hello", "billy@example.com", false, FOOTER),
    `Hello\n\nBilly\n\n${FOOTER}`,
  );
});

test("ensureComplianceFooter does not duplicate existing footer", () => {
  const body = `Hello\n\nBilly\n\n${FOOTER}`;
  assert.equal(ensureComplianceFooter(body, FOOTER, false), body);
});

test("list-unsubscribe token round-trip", () => {
  const secret = "test-secret-at-least-eight";
  const token = createUnsubscribeToken(
    { recipientEmail: "Lead@Example.COM", notionPageId: "page-abc" },
    secret,
    3600,
  );
  const verified = verifyUnsubscribeToken(token, secret);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.payload.recipientEmail, "lead@example.com");
    assert.equal(verified.payload.notionPageId, "page-abc");
  }
});

test("buildListUnsubscribeHeaders follows RFC 8058 shape", () => {
  const headers = buildListUnsubscribeHeaders({
    publicBaseUrl: "https://api.example.com",
    unsubscribePath: "/unsubscribe",
    token: "tok",
  });
  assert.deepEqual(headers, [
    { name: "List-Unsubscribe", value: "<https://api.example.com/unsubscribe/tok>" },
    { name: "List-Unsubscribe-Post", value: "List-Unsubscribe=One-Click" },
  ]);
});

test("canIssueListUnsubscribeHeaders requires https public base", () => {
  assert.equal(canIssueListUnsubscribeHeaders("https://x.example.com"), true);
  assert.equal(canIssueListUnsubscribeHeaders("http://x.example.com"), false);
  assert.equal(canIssueListUnsubscribeHeaders(""), false);
});
