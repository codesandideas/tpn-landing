-- Contact form submissions. Times are UTC, ISO 8601.
CREATE TABLE IF NOT EXISTS submissions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL,
  phone         TEXT,
  service       TEXT,
  message       TEXT NOT NULL,
  ip            TEXT,
  country       TEXT,
  user_agent    TEXT,
  notify_status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_submissions_ip_time ON submissions (ip, created_at);

-- Failed admin sign-ins, for rate limiting. Rows older than a day are cleared.
CREATE TABLE IF NOT EXISTS login_failures (
  ip TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_login_failures_ip_time ON login_failures (ip, at);
