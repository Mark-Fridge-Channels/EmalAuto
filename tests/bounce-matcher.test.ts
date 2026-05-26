import assert from "node:assert/strict";
import test from "node:test";

import { extractFailedRecipientEmails } from "../src/services/bounce-matcher.service.js";

test("extractFailedRecipientEmails: Google NDR", () => {
  const emails = extractFailedRecipientEmails({
    subject: "Address not found",
    bodyPreview: `Your message wasn't delivered to micah@rootcology.com because the address couldn't be found.`,
  });
  assert.deepEqual(emails, ["micah@rootcology.com"]);
});

test("extractFailedRecipientEmails: Amazon NDR", () => {
  const emails = extractFailedRecipientEmails({
    subject: "Delivery has failed to these recipients or groups:",
    bodyPreview: `collint@amazon.com\nRemote Server returned '554 5.1.1 bounced address: could not resolve address collint@amazon.com'`,
  });
  assert.equal(emails[0], "collint@amazon.com");
});

test("extractFailedRecipientEmails: Mimecast / postmaster NDR", () => {
  const emails = extractFailedRecipientEmails({
    subject: "Your message couldn't be delivered",
    bodyPreview: `The message you sent to ariana@princesspolly.com couldn't be delivered due to: Recipient email address is possibly incorrect.`,
  });
  assert.deepEqual(emails, ["ariana@princesspolly.com"]);
});

test("extractFailedRecipientEmails: ignores mailer-daemon addresses", () => {
  const emails = extractFailedRecipientEmails(
    {
      subject: "Delivery Status Notification (Failure)",
      bodyPreview: "From: mailer-daemon@googlemail.com\nTo: sender@fcconnect.co",
    },
    "sender@fcconnect.co",
  );
  assert.equal(emails.length, 0);
});
