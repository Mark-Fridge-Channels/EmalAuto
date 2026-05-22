import assert from "node:assert/strict";
import test from "node:test";

import { ensureSenderSignature, signatureNameFromMailbox } from "../src/services/mail-signature.service.js";

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

test("ensureSenderSignature does not duplicate existing authored HTML signature", () => {
  const body = `<p>Hello</p><p>Paula</p><hr><blockquote><p>Old mail</p></blockquote>`;
  assert.equal(ensureSenderSignature(body, "paula@example.com", true), body);
});
