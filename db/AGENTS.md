# db/ — SQLite Persistence Layer

## Purpose

Provides a SQLite database for persisting tweets, users, articles, and media
retrieved from X API calls. Every tool handler that returns content automatically
saves it to the database without altering the MCP response.

## Files

| File | Exports | Purpose |
|------|---------|---------|
| `connection.ts` | `getDb()`, `getDbPath()` | Singleton Database instance backed by `~/.x-api-mcp/x-data.db` |
| `schema.ts` | `initSchema(db)` | DDL for all tables; called once at server startup |
| `types.ts` | `TweetRow`, `UserRow`, `ArticleRow`, `MediaRow` | TypeScript interfaces matching SQLite column types |

## Conventions

- `getDb()` is the only way to obtain the database instance — never construct `Database` directly in tool handlers
- All DB calls in tool handlers must be wrapped in `try/catch`; DB errors write to `process.stderr` and must never propagate to MCP responses
- Upsert pattern: `INSERT OR REPLACE INTO` — safe to call with the same data multiple times
- `saved_at` is always an ISO timestamp (`new Date().toISOString()`)
- Nullable columns use `null` in TypeScript (not `undefined`)

## Database Path

Default: `~/.x-api-mcp/x-data.db`
Override: `X_API_DB_PATH` environment variable

## Relationships

- `db/repos/` — repository functions that use `getDb()` to read/write each table
- `server.ts` — calls `initSchema(getDb())` at startup
- `tools/` — tool handlers call repo functions after successful API responses
