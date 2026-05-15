CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version integer PRIMARY KEY,
  filename text NOT NULL UNIQUE,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);
