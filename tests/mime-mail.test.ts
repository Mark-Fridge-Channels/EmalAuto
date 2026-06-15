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
  assert.match(
    mime,
    /^List-Unsubscribe: <mailto:kacey@getfridgechannel\.com\?subject=unsubscribe>, <https:\/\/api\.example\.com\/unsubscribe\/tok>/m,
  );
  assert.match(mime, /^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
  assert.match(mime, /^Content-Type: text\/html; charset="UTF-8"/m);
  assert.match(mime, /^Content-Transfer-Encoding: base64/m);
  const b64Block = mime.split("\r\n\r\n").pop() ?? "";
  const html = Buffer.from(b64Block.replace(/\r\n/g, ""), "base64").toString("utf8");
  assert.equal(html, "<p>Hi</p>");
});
