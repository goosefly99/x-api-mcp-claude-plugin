import Database from 'better-sqlite3'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const DEFAULT_DB_DIR = path.join(os.homedir(), '.x-api-mcp')
const DEFAULT_DB_PATH = path.join(DEFAULT_DB_DIR, 'x-data.db')

const DB_PATH = process.env.X_API_DB_PATH ?? DEFAULT_DB_PATH
const IS_DEFAULT_PATH = DB_PATH === DEFAULT_DB_PATH

let _db: Database.Database | null = null

/**
 * Returns the singleton SQLite database instance, creating it on first call.
 * The database file is stored at ~/.x-api-mcp/x-data.db by default,
 * overridable via the X_API_DB_PATH environment variable.
 *
 * When using the default path, the parent directory is auto-created.
 * When a custom path is provided via X_API_DB_PATH, the parent directory
 * must already exist — otherwise better-sqlite3 will raise an explicit error.
 */
export function getDb(): Database.Database {
  if (_db) return _db

  if (IS_DEFAULT_PATH) {
    fs.mkdirSync(DEFAULT_DB_DIR, { recursive: true })
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
