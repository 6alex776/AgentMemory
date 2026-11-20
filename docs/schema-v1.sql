PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA busy_timeout = 5000;
PRAGMA foreign_keys = ON;

CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;

CREATE TABLE project (
  id           INTEGER PRIMARY KEY,
  key          TEXT NOT NULL UNIQUE,
  root_path    TEXT NOT NULL,
  name         TEXT NOT NULL,
  aliases      TEXT NOT NULL DEFAULT '[]',
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  archived_at  INTEGER
) STRICT;

CREATE TABLE memory (
  id             TEXT PRIMARY KEY,
  scope          TEXT NOT NULL CHECK (scope IN ('global','project')),
  project_id     INTEGER REFERENCES project(id),
  kind           TEXT NOT NULL CHECK (kind IN ('profile','preference','fact','decision','lesson','episode')),
  topic_key      TEXT,
  content        TEXT NOT NULL,
  content_norm   TEXT NOT NULL,
  search_text    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active'
                 CHECK (status IN ('active','superseded','expired','deleted')),
  origin         TEXT NOT NULL CHECK (origin IN ('user','agent','dream','import')),
  confidence     REAL NOT NULL DEFAULT 1.0 CHECK (confidence BETWEEN 0 AND 1),
  importance     INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  pinned         INTEGER NOT NULL DEFAULT 0,
  rev            INTEGER NOT NULL DEFAULT 1,
  source_session TEXT,
  source_seq     INTEGER,
  supersedes_id  TEXT REFERENCES memory(id),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  valid_from     INTEGER,
  valid_to       INTEGER,
  last_used_at   INTEGER,
  use_count      INTEGER NOT NULL DEFAULT 0,
  CHECK ((scope = 'project') = (project_id IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX memory_slot ON memory(scope, ifnull(project_id,0), topic_key)
  WHERE status = 'active' AND topic_key IS NOT NULL;

CREATE UNIQUE INDEX memory_dedupe ON memory(scope, ifnull(project_id,0), kind, ifnull(topic_key,''), content_norm)
  WHERE status = 'active';

CREATE INDEX memory_scan ON memory(scope, project_id, status, kind, importance DESC, updated_at DESC);
CREATE INDEX memory_by_topic ON memory(scope, project_id, topic_key, updated_at);

CREATE TABLE memory_version (
  id          INTEGER PRIMARY KEY,
  memory_id   TEXT NOT NULL REFERENCES memory(id),
  op          TEXT NOT NULL CHECK (op IN ('create','update','supersede','merge','expire','delete','restore','pin','import')),
  before_json TEXT,
  after_json  TEXT,
  actor       TEXT NOT NULL CHECK (actor IN ('user','agent','dream','migration')),
  reason      TEXT,
  session_id  TEXT,
  job_id      TEXT,
  created_at  INTEGER NOT NULL
) STRICT;
CREATE INDEX memory_version_by_memory ON memory_version(memory_id, created_at);

CREATE TABLE session_cursor (
  session_id          TEXT PRIMARY KEY,
  project_id          INTEGER REFERENCES project(id),
  last_event_seq      INTEGER NOT NULL DEFAULT 0,
  last_turn           INTEGER NOT NULL DEFAULT 0,
  last_attempt_digest TEXT,
  last_attempt_at     INTEGER,
  backlog_chars       INTEGER NOT NULL DEFAULT 0,
  state               TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','closed','skipped')),
  updated_at          INTEGER NOT NULL
) STRICT;

CREATE TABLE dream_job (
  id          TEXT PRIMARY KEY,
  project_id  INTEGER REFERENCES project(id),
  session_id  TEXT,
  from_seq    INTEGER NOT NULL,
  to_seq      INTEGER NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  added       INTEGER NOT NULL DEFAULT 0,
  updated     INTEGER NOT NULL DEFAULT 0,
  superseded  INTEGER NOT NULL DEFAULT 0,
  tokens_in   INTEGER,
  tokens_out  INTEGER,
  created_at  INTEGER NOT NULL,
  started_at  INTEGER,
  finished_at INTEGER
) STRICT;

CREATE TABLE dream_proposal (
  id         INTEGER PRIMARY KEY,
  job_id     TEXT NOT NULL REFERENCES dream_job(id),
  target_id  TEXT REFERENCES memory(id),
  op         TEXT NOT NULL,
  payload    TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','rejected')),
  created_at INTEGER NOT NULL,
  decided_at INTEGER
) STRICT;

CREATE VIRTUAL TABLE memory_fts USING fts5(search_text, tokenize = 'unicode61');

CREATE TRIGGER memory_ai AFTER INSERT ON memory BEGIN
  INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
CREATE TRIGGER memory_ad AFTER DELETE ON memory BEGIN
  DELETE FROM memory_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER memory_au AFTER UPDATE OF search_text ON memory BEGIN
  DELETE FROM memory_fts WHERE rowid = old.rowid;
  INSERT INTO memory_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

INSERT INTO meta(key, value) VALUES ('schema_version','1'), ('app_id','agentmemory');
