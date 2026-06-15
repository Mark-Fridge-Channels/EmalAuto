CREATE TABLE IF NOT EXISTS email_suppressions (
  id serial PRIMARY KEY,
  email text NOT NULL,
  notion_page_id text,
  source text NOT NULL DEFAULT 'list_unsubscribe_one_click',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_email_uniq ON email_suppressions (email);

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
