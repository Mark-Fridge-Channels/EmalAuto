import assert from "node:assert/strict";
import test from "node:test";

import {
  buildOpenPixelUrl,
  canIssueOpenTracking,
  createOpenTrackToken,
  injectOpenPixel,
  verifyOpenTrackToken,
} from "../src/services/open-tracking.service.js";

test("open-track token round-trip", () => {
  const secret = "test-secret-at-least-eight";
  const token = createOpenTrackToken(
    { recipientEmail: "Lead@Example.COM", notionPageId: "page-abc" },
    secret,
    3600,
  );
  const verified = verifyOpenTrackToken(token, secret);
  assert.equal(verified.ok, true);
  if (verified.ok) {
    assert.equal(verified.payload.purpose, "open");
    assert.equal(verified.payload.recipientEmail, "lead@example.com");
    assert.equal(verified.payload.notionPageId, "page-abc");
  }
});

test("open-track token rejects wrong purpose / bad sig", () => {
  const secret = "test-secret-at-least-eight";
  const token = createOpenTrackToken(
    { recipientEmail: "a@b.com", notionPageId: "p1" },
    secret,
    3600,
  );
  assert.equal(verifyOpenTrackToken(token, "other-secret-xxxxxxxx").ok, false);
  assert.equal(verifyOpenTrackToken("not.a.token", secret).ok, false);
});

test("buildOpenPixelUrl ends with .gif", () => {
  const url = buildOpenPixelUrl({
    publicBaseUrl: "https://api.example.com",
    openPath: "/t/o",
    token: "abc.def",
  });
  assert.equal(url, "https://api.example.com/t/o/abc.def.gif");
});

test("injectOpenPixel is idempotent and prefers before </body>", () => {
  const url = "https://api.example.com/t/o/tok.gif";
  const html = "<html><body><p>Hi</p></body></html>";
  const once = injectOpenPixel(html, url);
  assert.match(once, /<img src="https:\/\/api\.example\.com\/t\/o\/tok\.gif"/);
  assert.match(once, /<\/p><img[\s\S]*<\/body>/);
  assert.equal(injectOpenPixel(once, url), once);
});

test("canIssueOpenTracking requires https + secret + enabled", () => {
  assert.equal(
    canIssueOpenTracking({
      enabled: true,
      publicBaseUrl: "https://x.example",
      secret: "12345678",
    }),
    true,
  );
  assert.equal(
    canIssueOpenTracking({
      enabled: false,
      publicBaseUrl: "https://x.example",
      secret: "12345678",
    }),
    false,
  );
  assert.equal(
    canIssueOpenTracking({
      enabled: true,
      publicBaseUrl: "http://x.example",
      secret: "12345678",
    }),
    false,
  );
});
