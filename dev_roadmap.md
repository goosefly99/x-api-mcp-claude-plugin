# x-api-mcp Development Roadmap

This file tracks phased implementation progress for the x-api-mcp MCP server.
Development agents read this file to determine what to work on next, and update
the status column after completing each item. Never mark an item `Complete` if
the build is broken or type-check fails.

---

## Feature: SQL Persistence Layer

**Objective:** Add a SQLite database to persist tweets, users, articles, and media
retrieved from the X API and article crawler. Every tool call that returns content
automatically saves it to the database. New query tools expose the saved data.

**Database:** SQLite via `better-sqlite3`, stored at `W:\x_posts_db\x-data.db`.

**Key design decisions:**
- Upsert pattern (`INSERT OR REPLACE`) — safe to refetch the same tweet
- DB failures must never break MCP tool responses (wrap all saves in try/catch)
- `source` column on tweets/articles tracks which tool produced the save
- New tools `x_get_saved_tweets` and `x_get_saved_articles` expose the DB to Claude

---

## Schema Reference

### `tweets`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | X tweet ID |
| text | TEXT | Short tweet text (may be truncated for articles) |
| note_tweet_text | TEXT | Full article content from note_tweet.text |
| author_id | TEXT | FK → users.id |
| conversation_id | TEXT | Thread root ID |
| created_at | TEXT | ISO timestamp from X API |
| retweet_count | INTEGER | |
| reply_count | INTEGER | |
| like_count | INTEGER | |
| quote_count | INTEGER | |
| impression_count | INTEGER | |
| bookmark_count | INTEGER | |
| entities_json | TEXT | JSON: urls, mentions, hashtags |
| referenced_tweets_json | TEXT | JSON: [{type, id}] |
| saved_at | TEXT | ISO timestamp when we persisted this row |
| source | TEXT | 'bookmarks' \| 'search' \| 'get_tweet' \| 'user_tweets' \| 'thread' |

### `users`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | X user ID |
| name | TEXT | Display name |
| username | TEXT | Handle (no @) |
| description | TEXT | Bio |
| followers_count | INTEGER | |
| following_count | INTEGER | |
| tweet_count | INTEGER | |
| profile_image_url | TEXT | |
| verified | INTEGER | 0 or 1 |
| created_at | TEXT | Account creation date |
| url | TEXT | Profile URL |
| location | TEXT | |
| saved_at | TEXT | ISO timestamp when we persisted this row |

### `articles`
| Column | Type | Notes |
|--------|------|-------|
| id | TEXT PK | tweet_id for API articles; URL for crawled |
| tweet_id | TEXT | Null for crawled-only articles |
| author_id | TEXT | Null for crawled-only |
| author_username | TEXT | Cached at save time |
| content | TEXT | Full article/note_tweet text |
| source | TEXT | 'api' \| 'crawl' |
| url | TEXT | x.com article URL if known |
| saved_at | TEXT | ISO timestamp |

### `media`
| Column | Type | Notes |
|--------|------|-------|
| media_key | TEXT PK | X media_key |
| tweet_id | TEXT | Parent tweet |
| type | TEXT | 'photo' \| 'video' \| 'animated_gif' |
| url | TEXT | Best-quality URL |
| preview_image_url | TEXT | |
| alt_text | TEXT | |

---

## Priority Ranking

| # | Item | Phase | Priority | Estimated Effort |
|---|------|-------|----------|-----------------|
| 1 | Install `better-sqlite3` and `@types/better-sqlite3` | 1 | P0 | 15 min |
| 2 | Create `db/connection.ts` — singleton DB with file path `~/.x-api-mcp/x-data.db` | 1 | P0 | 30 min |
| 3 | Create `db/schema.ts` — DDL for all four tables plus `schema_version` | 1 | P0 | 45 min |
| 4 | Create `db/types.ts` — TypeScript row interfaces matching DDL columns | 1 | P0 | 30 min |
| 5 | Wire schema initialization into `server.ts` startup before transport connect | 1 | P0 | 15 min |
| 6 | Create `db/repos/users.ts` — `upsertUser`, `queryUsers` | 2 | P0 | 30 min |
| 7 | Create `db/repos/tweets.ts` — `upsertTweet`, `upsertTweets`, `queryTweets` | 2 | P0 | 45 min |
| 8 | Create `db/repos/articles.ts` — `upsertArticle`, `queryArticles` | 2 | P0 | 30 min |
| 9 | Create `db/repos/media.ts` — `upsertMedia` | 2 | P1 | 20 min |
| 10 | Integrate user + tweet saving into `tools/bookmarks.ts` | 3 | P0 | 20 min |
| 11 | Integrate user + tweet saving into `tools/search.ts` | 3 | P0 | 20 min |
| 12 | Integrate user + tweet saving into `tools/tweets.ts` (get_tweet, get_user_tweets) | 3 | P0 | 20 min |
| 13 | Integrate user + tweet saving into `tools/thread.ts` | 3 | P0 | 20 min |
| 14 | Integrate article saving into `tools/article.ts` (get_article via API) | 3 | P0 | 20 min |
| 15 | Integrate article saving into `tools/crawl.ts` (crawl_article via browser) | 3 | P0 | 20 min |
| 16 | Create `tools/saved_tweets.ts` — `x_get_saved_tweets` handler | 4 | P0 | 45 min |
| 17 | Create `tools/saved_articles.ts` — `x_get_saved_articles` handler | 4 | P0 | 45 min |
| 18 | Create `tools/saved_users.ts` — `x_get_saved_users` handler | 4 | P1 | 30 min |
| 19 | Register `x_get_saved_tweets`, `x_get_saved_articles`, `x_get_saved_users` in `server.ts` | 4 | P0 | 20 min |
| 20 | Wrap all DB calls in try/catch — DB errors must not propagate to MCP responses | 5 | P0 | 30 min |
| 21 | Add DB row counts to server startup stderr log | 5 | P2 | 15 min |
| 22 | Run `tsc --noEmit` project-wide and fix all type errors | 5 | P0 | 30 min |

---

## Phase Descriptions

### Phase 1 — Database Foundation

**Goal:** A working SQLite database connection is established at server startup with all tables created and ready to accept rows.

**Items:** #1–#5

**Key deliverables:**
- `package.json` — `better-sqlite3` and `@types/better-sqlite3` added as dependencies
- `db/connection.ts` — exports a lazy singleton `getDb()` returning a `Database` instance backed by `W:\x_posts_db\x-data.db`
- `db/schema.ts` — exports `initSchema(db)` which creates the `tweets`, `users`, `articles`, `media`, and `schema_version` tables with `IF NOT EXISTS`
- `db/types.ts` — exports `TweetRow`, `UserRow`, `ArticleRow`, `MediaRow` interfaces
- `server.ts` — calls `initSchema(getDb())` before `server.connect(transport)` so the DB is ready before any tool can run

---

### Phase 2 — Repository Layer

**Goal:** Typed repository functions for all four tables are implemented and ready to be called by tool handlers.

**Items:** #6–#9

**Key deliverables:**
- `db/repos/users.ts` — `upsertUser(db, user: XUser): void` and `queryUsers(db, opts): UserRow[]`
- `db/repos/tweets.ts` — `upsertTweet(db, tweet: XTweet, source: string): void`, `upsertTweets(db, tweets: XTweet[], includes: XIncludes | undefined, source: string): void`, `queryTweets(db, opts): TweetRow[]`
- `db/repos/articles.ts` — `upsertArticle(db, article: ArticleInput): void`, `queryArticles(db, opts): ArticleRow[]`
- `db/repos/media.ts` — `upsertMedia(db, tweetId: string, media: XMedia[]): void`

**Notes for `upsertTweets`:** This is the shared helper called by all tweet-returning tools. It saves the tweet, saves all users from `includes.users`, saves media from `includes.media`, and optionally saves article content if `note_tweet` is present.

---

### Phase 3 — Tool Integration

**Goal:** Every tool that returns tweet or article content now automatically saves it to the database without any visible change to MCP response behavior.

**Items:** #10–#15

**Key deliverables:**
- All tool handlers that call `xApiRequest` for tweets now also call `upsertTweets(getDb(), response.data, response.includes, '<source-name>')` after a successful response
- `tools/article.ts` calls `upsertArticle(getDb(), {...})` when a valid note_tweet is returned
- `tools/crawl.ts` calls `upsertArticle(getDb(), {...})` when crawl succeeds
- All DB calls are wrapped in `try/catch` — any DB failure writes to `process.stderr` but does not alter the MCP response

---

### Phase 4 — Query Tools

**Goal:** Three new MCP tools expose the saved database to Claude, allowing retrieval, search, and filtering without making API calls.

**Items:** #16–#19

**Key deliverables:**

**`x_get_saved_tweets`** — `tools/saved_tweets.ts`
- Parameters: `query?` (text search in tweet text + note_tweet_text), `author?` (username filter), `source?` ('bookmarks'|'search'|'get_tweet'|'user_tweets'|'thread'), `limit?` (default 20, max 100), `offset?` (default 0)
- Returns formatted tweet blocks from the local DB

**`x_get_saved_articles`** — `tools/saved_articles.ts`
- Parameters: `query?` (text search in content), `author?` (username), `source?` ('api'|'crawl'), `limit?` (default 10, max 50), `offset?`
- Returns article blocks with author, date, content snippet

**`x_get_saved_users`** — `tools/saved_users.ts`
- Parameters: `query?` (search in username + name + description), `limit?` (default 20), `offset?`
- Returns formatted user profiles from the local DB

---

### Phase 5 — Hardening and Verification

**Goal:** The feature is resilient to DB failures, type-clean, and production-ready.

**Items:** #20–#22

**Key deliverables:**
- All 15 DB call sites (Phases 2-4) verified to have try/catch wrapping
- `server.ts` startup logs DB path and row counts: `x-api: DB ready at W:\x_posts_db\x-data.db (tweets: N, articles: N)`
- `tsc --noEmit` passes with zero errors across the entire project

---

## Ideas / Future Work

These items are not scheduled but should be appended to the roadmap when prioritized:

- **Full-text search index** — SQLite FTS5 virtual table over `tweets.text + tweets.note_tweet_text` for fast keyword search
- **Deduplication report tool** — `x_get_saved_stats` showing counts by source, date range, top authors
- **Tag/label system** — allow Claude to label saved tweets (e.g. "trading strategy", "watch later") via a new `x_tag_tweet` tool and `tweet_tags` table
- **Export tool** — `x_export_saved` to write saved tweets/articles to a JSON or Markdown file
- **User tweet history** — track which tweets were seen per user, surface "new since last fetch" in `x_get_user_tweets`

---

## Tracking

| # | Item | Phase | Status |
|---|------|-------|--------|
| 1 | Install `better-sqlite3` and `@types/better-sqlite3` | 1 | Complete |
| 2 | Create `db/connection.ts` — singleton DB | 1 | Complete |
| 3 | Create `db/schema.ts` — DDL for all tables | 1 | Complete |
| 4 | Create `db/types.ts` — row interfaces | 1 | Complete |
| 5 | Wire schema init in `server.ts` startup | 1 | Complete |
| 6 | Create `db/repos/users.ts` | 2 | Complete |
| 7 | Create `db/repos/tweets.ts` | 2 | Complete |
| 8 | Create `db/repos/articles.ts` | 2 | Complete |
| 9 | Create `db/repos/media.ts` | 2 | Complete |
| 10 | Integrate saving into `tools/bookmarks.ts` | 3 | Complete |
| 11 | Integrate saving into `tools/search.ts` | 3 | Complete |
| 12 | Integrate saving into `tools/tweets.ts` | 3 | Complete |
| 13 | Integrate saving into `tools/thread.ts` | 3 | Complete |
| 14 | Integrate article saving into `tools/article.ts` | 3 | Complete |
| 15 | Integrate article saving into `tools/crawl.ts` | 3 | Complete |
| 16 | Create `tools/saved_tweets.ts` — x_get_saved_tweets | 4 | Complete |
| 17 | Create `tools/saved_articles.ts` — x_get_saved_articles | 4 | Complete |
| 18 | Create `tools/saved_users.ts` — x_get_saved_users | 4 | Complete |
| 19 | Register new tools in `server.ts` | 4 | Complete |
| 20 | Wrap all DB calls in try/catch | 5 | Complete |
| 21 | Add DB stats to startup log | 5 | Complete |
| 22 | Run tsc --noEmit, fix all type errors | 5 | Complete |
