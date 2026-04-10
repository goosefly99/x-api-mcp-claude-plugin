import Database from 'better-sqlite3'
import path from 'node:path'
import fs from 'node:fs'

const DB_PATH = process.env.X_API_DB_PATH ?? 'W:\\x_posts_db\\x-data.db'

let _db: Database.Database | null = null

/**
 * Returns the singleton SQLite database instance, creating it on first call.
 * The database file is stored at ~/.x-api-mcp/x-data.db by default,
 * overridable via the X_API_DB_PATH environment variable.
 */
export function getDb(): Database.Database {
  if (_db) return _db

  const dir = path.dirname(DB_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  _db = new Database(DB_PATH)
  // Enable WAL mode for better concurrent read performance
  _db.pragma('journal_mode = WAL')
  // Foreign keys on
  _db.pragma('foreign_keys = ON')

  return _db
}

/** Exposed for logging purposes */
export function getDbPath(): string {
  return DB_PATH
}
