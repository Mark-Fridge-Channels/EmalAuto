-- EmalAuto full PostgreSQL schema (idempotent).
-- Use when you do not run drizzle-kit migrate. Applies all tables + indexes
-- including V2 `webhook_subscriptions.folder`.

CREATE TABLE IF NOT EXISTS mailboxes (
  id serial PRIMARY KEY,
  email text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  can_send boolean NOT NULL DEFAULT true,
  can_receive boolean NOT NULL DEFAULT true,
  inbox_last_sync_at timestamptz,
  junk_last_sync_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS mailboxes_email_uniq ON mailboxes (email);

CREATE TABLE IF NOT EXISTS outbound_messages (
  id serial PRIMARY KEY,
  mailbox_id integer NOT NULL REFERENCES mailboxes (id),
  notion_page_id text NOT NULL,
  graph_message_id text NOT NULL,
  internet_message_id text,
  conversation_id text NOT NULL,
  subject text NOT NULL DEFAULT '',
  sent_at timestamptz NOT NULL,
  recipients_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  thread_status text NOT NULL DEFAULT 'sent',
  bounce_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS outbound_conversation_idx ON outbound_messages (conversation_id);
CREATE INDEX IF NOT EXISTS outbound_mailbox_sent_idx ON outbound_messages (mailbox_id, sent_at);
CREATE INDEX IF NOT EXISTS outbound_notion_page_idx ON outbound_messages (notion_page_id);
CREATE UNIQUE INDEX IF NOT EXISTS outbound_graph_msg_uniq ON outbound_messages (mailbox_id, graph_message_id);

CREATE TABLE IF NOT EXISTS inbox_messages (
  id serial PRIMARY KEY,
  mailbox_id integer NOT NULL REFERENCES mailboxes (id),
  folder text NOT NULL,
  graph_message_id text NOT NULL,
  internet_message_id text,
  conversation_id text NOT NULL,
  from_email text NOT NULL DEFAULT '',
  recipients_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  subject text NOT NULL DEFAULT '',
  received_at timestamptz NOT NULL,
  body_preview text NOT NULL DEFAULT '',
  raw_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  match_status text NOT NULL DEFAULT 'unmatched',
  matched_outbound_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS inbox_msg_uniq ON inbox_messages (mailbox_id, graph_message_id);
CREATE INDEX IF NOT EXISTS inbox_conversation_idx ON inbox_messages (conversation_id);
CREATE INDEX IF NOT EXISTS inbox_mailbox_recv_idx ON inbox_messages (mailbox_id, received_at);

CREATE TABLE IF NOT EXISTS conversation_map (
  id serial PRIMARY KEY,
  conversation_id text NOT NULL,
  notion_page_id text NOT NULL,
  latest_inbox_id integer,
  latest_inbound_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS conv_map_conv_uniq ON conversation_map (conversation_id);
CREATE INDEX IF NOT EXISTS conv_map_page_idx ON conversation_map (notion_page_id);

CREATE TABLE IF NOT EXISTS webhook_subscriptions (
  id serial PRIMARY KEY,
  mailbox_id integer NOT NULL REFERENCES mailboxes (id),
  folder text NOT NULL DEFAULT 'inbox',
  subscription_id text NOT NULL,
  expires_at timestamptz NOT NULL,
  delta_link text,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_sub_uniq ON webhook_subscriptions (subscription_id);
CREATE UNIQUE INDEX IF NOT EXISTS webhook_mailbox_folder_uniq ON webhook_subscriptions (mailbox_id, folder);

-- Row Level Security: Supabase exposes tables via PostgREST; without RLS, anon/authenticated
-- keys could read/write everything. Enabling RLS with no policies denies API access for those
-- roles. Backend using SUPABASE_SERVICE_ROLE_KEY bypasses RLS and keeps full access.
-- Add explicit policies here only if you need Supabase client / auth.uid() access to rows.

ALTER TABLE mailboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE inbox_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE conversation_map ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_subscriptions ENABLE ROW LEVEL SECURITY;
