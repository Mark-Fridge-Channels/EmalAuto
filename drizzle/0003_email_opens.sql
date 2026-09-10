CREATE TABLE IF NOT EXISTS email_opens (
  id serial PRIMARY KEY,
  email text NOT NULL,
  notion_page_id text,
  outbound_id integer,
  user_agent text,
  ip_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_opens_email_idx ON email_opens (email);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_opens_notion_idx ON email_opens (notion_page_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_opens_outbound_idx ON email_opens (outbound_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS email_opens_created_idx ON email_opens (created_at);
--> statement-breakpoint
ALTER TABLE email_opens ENABLE ROW LEVEL SECURITY;
