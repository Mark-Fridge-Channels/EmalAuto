import assert from "node:assert/strict";
import test from "node:test";

import { buildOutboundMimeMessage } from "../src/services/mime-mail.service.js";

test("buildOutboundMimeMessage includes RFC 8058 unsubscribe headers", () => {
  const mime = buildOutboundMimeMessage({
    fromMailbox: "kacey@getfridgechannel.com",
    to: ["test@gmail.com"],
    subject: "Hello",
    bodyHtml: "<p>Hi</p>",
    listUnsubscribeUrl: "https://api.example.com/unsubscribe/tok",
  });
  assert.match(mime, /^From: Kacey <kacey@getfridgechannel\.com>/m);
  assert.match(mime, /^List-Unsubscribe: <mailto:kacey@getfridgechannel\.com\?subject=unsubscribe>/m);
  assert.match(mime, /api\.example\.com\/unsubscribe\/tok>/m);
  assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
  assert.match(mime, /^Date: /m);
  assert.match(mime, /^Message-ID: </m);
  assert.match(mime, /^Content-Type: multipart\/alternative; boundary="/m);
  assert.match(mime, /Content-Type: text\/html; charset="UTF-8"/m);
  assert.match(mime, /Content-Transfer-Encoding: base64/m);

  const htmlPart = mime.split('Content-Type: text/html; charset="UTF-8"')[1] ?? "";
  const b64Block = htmlPart.split("\r\n\r\n")[1]?.split("\r\n--")[0] ?? "";
  const html = Buffer.from(b64Block.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(html, "<p>Hi</p>");
});

test("buildOutboundMimeMessage keeps List-Unsubscribe URL intact", () => {
  const longUrl = `https://email_webhook.fridgechannels.com/unsubscribe/${"a".repeat(200)}`;
  const mime = buildOutboundMimeMessage({
    fromMailbox: "billy@fridgeteam.com",
    to: ["mark@fridgechannels.com"],
    subject: "Hello",
    bodyHtml: "<div>Hi</div>",
    listUnsubscribeUrl: longUrl,
  });
  assert.doesNotMatch(mime, /<https:\s+\/\//);
  assert.match(mime, new RegExp(longUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
