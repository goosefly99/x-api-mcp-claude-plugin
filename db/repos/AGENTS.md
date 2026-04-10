# db/repos/ — Repository Functions

## Purpose

Typed repository functions for reading and writing each database table.
These are the only approved way for tool handlers to interact with the database.

## Files

| File | Key Exports | Table |
|------|------------|-------|
| `users.ts` | `upsertUser`, `queryUsers` | `users` |
| `tweets.ts` | `upsertTweet`, `upsertTweets`, `queryTweets` | `tweets` |
| `articles.ts` | `upsertArticle`, `queryArticles` | `articles` |
| `media.ts` | `upsertMedia` | `media` |

## Conventions

- All functions accept a `Database.Database` instance as their first parameter
- `upsertTweets` is the shared helper for all tweet-returning tools: saves tweets, associated users, media, and article content from `note_tweet`
- Query functions accept an `opts` object with optional `query`, `author`, `source`, `limit`, `offset` fields
- All functions may throw — callers (tool handlers) must wrap in `try/catch`

## Relationships

- Imported from `db/connection.ts` via `getDb()`
- Called by `tools/*.ts` handlers after successful API responses
- Types come from `db/types.ts`; input types come from `types.ts` (XTweet, XUser, etc.)
