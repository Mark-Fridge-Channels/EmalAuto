ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "body" text NOT NULL DEFAULT '';
