# x-api-mcp-claude-plugin

X (Twitter) API MCP server — authenticated crawler, client, and query tools.

## What it does

This is a Claude Code plugin that registers an MCP server for interacting with
the X (Twitter) API and X Articles. It combines OAuth 2.0 API access with a
Playwright-based browser crawler for content the API cannot reach, and
persists fetched data to a local SQLite database for fast offline queries.

Exposed MCP tools include:

- `x_authorize` / `x_browser_login` — OAuth 2.0 and browser-session login
- `x_search_tweets` — search recent tweets with X search operators
- `x_get_tweet`, `x_get_user_tweets`, `x_get_user`, `x_get_thread` — API reads
- `x_get_bookmarks` — read your bookmarks (requires `x_authorize`)
- `x_get_article`, `x_crawl_article` — fetch X Articles via API or crawler
- `x_get_saved_tweets`, `x_get_saved_articles`, `x_get_saved_users` — query
  the local SQLite cache (no API calls)

## Installation

As a Claude Code plugin:

```
/plugin install goosefly99/x-api-mcp-claude-plugin
```

Or clone manually:

```
git clone https://github.com/goosefly99/x-api-mcp-claude-plugin.git
cd x-api-mcp-claude-plugin
npm install
```

The plugin auto-installs dependencies on first run via `start.mjs`.

## Configuration

The server requires the following environment variables (checked at startup):

- `X_API_CONSUMER_KEY` — X API consumer key
- `X_API_SECRET_KEY` — X API consumer secret
- `X_O_AUTH_2_0_CLIENT_ID` — OAuth 2.0 client ID for user authorization

Optional:

- `X_API_DB_PATH` — absolute path to the SQLite database file. Defaults to
  `~/.x-api-mcp/x-data.db` (resolved against the current user's home
  directory). The default directory is created automatically on first use.
  If you set a custom path, the parent directory must already exist.

Set these via your shell environment or a local `.env` file (ignored by git).

OAuth 2.0 user tokens (for `x_get_bookmarks` and friends) are stored at
`~/.x-tokens.json` after running `x_authorize`. This file is also gitignored
and should never be committed.

## Ecosystem version floor

This plugin ships as **v0.4.0** as part of the v0.3.0 sibling ecosystem drop
(kb 0.6.0 + yt 0.5.0 + x-api 0.4.0). The `data-etl-orchestrator` contract
probe (probe 4, ensemble-contract) refuses to dispatch unless
`x-api-mcp >= 0.4.0`. If you pin an older version, the orchestrator will
emit a structured upgrade message telling the user to install v0.4.0.
See `skills/references/contract-probe-protocol.md` in the orchestrator
repo for the full probe.

## Consumer-side every-call stderr capture (R1 mitigation)

Callers MUST tee the x-api server's stderr to a log file per request —
never fire-and-forget. v0.4.0 emits structured JSON stderr on three
critical paths:

- **Handler-layer metric row** (one per tool handler call via
  `withFailureIsolation`): `{ plugin:'x-api', tool, articles_attempted,
  articles_succeeded, articles_timed_out, articles_failed, elapsed_ms }`.
- **`PLAYWRIGHT_SOFT_TIMEOUT_WIN` canary** (one per soft-timeout-wins-race
  event — indicates a Playwright session we could not cancel mid-flight):
  `{ plugin:'x-api', error_code:'PLAYWRIGHT_SOFT_TIMEOUT_WIN',
  open_sockets_count, browser_context_id, tweet_id, elapsed_ms }`.
- **SCREAMING_SNAKE_CASE `error_code`** on silent-DB-failure events (e.g.
  `TWEET_UPSERT_CONFLICT` on composite-PK violations).

Dropping stderr reopens the silent-DB-failure blind spot that probe 4
assertion (d) was designed to close — the 100 ms stderr deadline only
surfaces a failure if the caller is actually reading stderr. The
orchestrator's probe 4 enforces this invariant at preflight; direct
callers bypassing the orchestrator must replicate the stderr-tee
discipline.

## Further documentation

- [`INSTRUCTIONS.md`](./INSTRUCTIONS.md) — detailed usage, tool reference, and
  operational notes.
- [`dev_roadmap.md`](./dev_roadmap.md) — development roadmap and planned
  features.
