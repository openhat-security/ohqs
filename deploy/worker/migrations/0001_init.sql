-- ohqs D1 schema. Equivalent of the local data/ohqs.sqlite layout plus a
-- `data` JSON column carrying the full catalog.Record for faithful API output.
-- Normally populated by:  ohqs index d1 && wrangler d1 execute ohqs --remote --file=dist/d1/seed.sql
-- This file exists so `wrangler d1 migrations apply` can create the tables for
-- local dev before loading seed data.

CREATE TABLE IF NOT EXISTS records (
  id TEXT PRIMARY KEY,
  name TEXT,
  kind TEXT,
  summary TEXT,
  tags TEXT,
  body TEXT,
  data TEXT
);

CREATE TABLE IF NOT EXISTS metadata (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS vectors (
  id TEXT PRIMARY KEY,
  dim INTEGER NOT NULL,
  vec TEXT NOT NULL
);

DROP TABLE IF EXISTS records_fts;
CREATE VIRTUAL TABLE records_fts USING fts5(id, name, kind, summary, tags, body);