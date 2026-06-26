import assert from "node:assert/strict";
import test from "node:test";

import { detectBounce } from "../src/services/bounce-detector.service.js";
import { detectReplyKind } from "../src/services/auto-reply-detector.service.js";

test("detectBounce: Office 365 NDR from microsoftexchange@onmicrosoft.com", () => {
  const verdict = detectBounce({
    fromEmail: "microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@netorgft20533245.onmicrosoft.com",
    subject: "Re: Nic — fridge-door retention for MYSA",
    bodyPreview:
      "Your message couldn't be delivered to the recipients shown below. mysa.wine suspects your message is spam and rejected it.",
  });
  assert.equal(verdict.isBounce, true);
  assert.match(verdict.reason, /from matched|body matched/);
});

test("detectBounce: O365 NDR body even when from is the original sender", () => {
  const verdict = detectBounce({
    fromEmail: "billy@fridgelink.co",
    subject: "Re: Nic — fridge-door retention for MYSA",
    bodyPreview:
      "Couldn't deliver the message to the following recipients: nic@mysa.wine, holly@mysa.wine",
  });
  assert.equal(verdict.isBounce, true);
  assert.match(verdict.reason, /body matched/);
});

test("detectBounce: Gmail mailer-daemon subject Address not found", () => {
  const verdict = detectBounce({
    fromEmail: "mailer-daemon@googlemail.com",
    subject: "Address not found",
    bodyPreview: "Your message wasn't delivered to micah@rootcology.com",
  });
  assert.equal(verdict.isBounce, true);
});

test("detectBounce: multipart/report delivery-status header", () => {
  const verdict = detectBounce({
    fromEmail: "sender@example.com",
    subject: "Re: hello",
    bodyPreview: "",
    headers: [
      {
        name: "Content-Type",
        value: 'multipart/report; report-type=delivery-status; boundary="abc"',
      },
    ],
  });
  assert.equal(verdict.isBounce, true);
  assert.match(verdict.reason, /Content-Type/);
});

test("detectBounce: normal human reply is not a bounce", () => {
  const verdict = detectBounce({
    fromEmail: "nic@mysa.wine",
    subject: "Re: Nic — fridge-door retention for MYSA",
    bodyPreview: "Thanks for reaching out — happy to chat next week.",
  });
  assert.equal(verdict.isBounce, false);
});

test("detectReplyKind: O365 NDR is not classified as auto-reply", () => {
  const verdict = detectReplyKind({
    fromEmail: "microsoftexchange329e71ec88ae4615bbc36ab6ce41109e@netorgft20533245.onmicrosoft.com",
    subject: "Re: Nic — fridge-door retention for MYSA",
    bodyPreview: "Your message couldn't be delivered to the recipients shown below.",
    headers: [{ name: "Auto-Submitted", value: "auto-generated" }],
  });
  assert.equal(verdict.kind, "human");
  assert.match(verdict.reason, /bounce detected/);
});

test("detectReplyKind: out-of-office still detected as auto-reply", () => {
  const verdict = detectReplyKind({
    fromEmail: "nic@mysa.wine",
    subject: "Automatic reply: Out of Office",
    bodyPreview: "I am currently out of the office and will respond when I return.",
    headers: [{ name: "Auto-Submitted", value: "auto-replied" }],
  });
  assert.equal(verdict.kind, "auto");
});
