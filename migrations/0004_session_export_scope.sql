CREATE TABLE oauth_scopes (
  hash TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX oauth_scopes_expiry ON oauth_scopes(expires_at);
