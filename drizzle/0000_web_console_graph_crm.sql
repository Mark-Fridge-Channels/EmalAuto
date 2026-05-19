CREATE TABLE IF NOT EXISTS "graph_apps" (
	"id" serial PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"tenant_id" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "graph_apps_domain_uniq" ON "graph_apps" USING btree ("domain");
--> statement-breakpoint
ALTER TABLE "outbound_messages" ALTER COLUMN "notion_page_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "key_person_id" text;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "key_person_name" text;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "key_person_notion_url" text;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "entity_name" text;
--> statement-breakpoint
ALTER TABLE "outbound_messages" ADD COLUMN IF NOT EXISTS "entity_notion_url" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_entity_name_idx" ON "outbound_messages" USING btree ("entity_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outbound_key_person_id_idx" ON "outbound_messages" USING btree ("key_person_id");
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "key_person_id" text;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "key_person_name" text;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "key_person_notion_url" text;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "entity_name" text;
--> statement-breakpoint
ALTER TABLE "inbox_messages" ADD COLUMN IF NOT EXISTS "entity_notion_url" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_entity_name_idx" ON "inbox_messages" USING btree ("entity_name");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "inbox_key_person_id_idx" ON "inbox_messages" USING btree ("key_person_id");
--> statement-breakpoint
ALTER TABLE "conversation_map" ALTER COLUMN "notion_page_id" DROP NOT NULL;
