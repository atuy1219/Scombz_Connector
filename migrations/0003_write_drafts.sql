CREATE TABLE write_drafts (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  result TEXT,
  owner TEXT NOT NULL
);
