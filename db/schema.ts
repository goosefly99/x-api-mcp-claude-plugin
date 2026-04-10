import type Database from 'better-sqlite3'

/**
 * Creates all database tables if they don't already exist.
 * Safe to call on every startup -- all statements use IF NOT EXISTS.
 */
export function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version   INTEGER NOT NULL,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id                TEXT PRIMARY KEY,
      name              TEXT,
      username          TEXT,
      description       TEXT,
      followers_count   INTEGER,
      following_count   INTEGER,
      tweet_count       INTEGER,
      profile_image_url TEXT,
      verified          INTEGER,
      created_at        TEXT,
      url               TEXT,
      location          TEXT,
      saved_at          TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tweets (
      id                     TEXT PRIMARY KEY,
      text                   TEXT,
      note_tweet_text        TEXT,
      author_id              TEXT,
      conversation_id        TEXT,
      created_at             TEXT,
      retweet_count          INTEGER,
      reply_count            INTEGER,
      like_count             INTEGER,
      quote_count            INTEGER,
      impression_count       INTEGER,
      bookmark_count         INTEGER,
      entities_json          TEXT,
      referenced_tweets_json TEXT,
      saved_at               TEXT NOT NULL,
      source                 TEXT
    );

    CREATE TABLE IF NOT EXISTS articles (
      id              TEXT PRIMARY KEY,
      tweet_id        TEXT,
      author_id       TEXT,
      author_username TEXT,
      content         TEXT,
      source          TEXT,
      url             TEXT,
      saved_at        TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media (
      media_key         TEXT PRIMARY KEY,
      tweet_id          TEXT,
      type              TEXT,
      url               TEXT,
      preview_image_url TEXT,
      alt_text          TEXT
    );
  `)

  // Insert initial schema version row if table is empty
  const count = (db.prepare('SELECT COUNT(*) as cnt FROM schema_version').get() as { cnt: number }).cnt
  if (count === 0) {
    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      1,
      new Date().toISOString()
    )
  }

  runMigrations(db)
}

/**
 * Applies incremental schema migrations based on the current version.
 * Each migration is idempotent — safe to call on every startup.
 */
export function runMigrations(db: Database.Database): void {
  const row = db.prepare('SELECT version FROM schema_version ORDER BY applied_at DESC LIMIT 1').get() as { version: number } | undefined
  const currentVersion = row?.version ?? 1

  if (currentVersion < 2) {
    // v2: add enrichment columns for imported/curated posts
    const addColumn = (col: string, def: string) => {
      try {
        db.exec(`ALTER TABLE tweets ADD COLUMN ${col} ${def}`)
      } catch {
        // column already exists — safe to ignore
      }
    }
    addColumn('title',        'TEXT')
    addColumn('summary',      'TEXT')
    addColumn('tags_json',    'TEXT')
    addColumn('category',     'TEXT')
    addColumn('projects_json','TEXT')

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      2,
      new Date().toISOString()
    )
  }

  if (currentVersion < 3) {
    // v3: add is_article flag from bookmarks schema
    try {
      db.exec('ALTER TABLE tweets ADD COLUMN is_article INTEGER DEFAULT 0')
    } catch {
      // column already exists — safe to ignore
    }

    db.prepare('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      3,
      new Date().toISOString()
    )
  }
}
