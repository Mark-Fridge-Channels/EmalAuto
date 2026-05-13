-- Patch existing DB created before V2: add `folder` + composite unique index.
-- Safe to run multiple times.

ALTER TABLE webhook_subscriptions
  ADD COLUMN IF NOT EXISTS folder text NOT NULL DEFAULT 'inbox';

DROP INDEX IF EXISTS webhook_mailbox_folder_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS webhook_mailbox_folder_uniq
  ON webhook_subscriptions (mailbox_id, folder);
