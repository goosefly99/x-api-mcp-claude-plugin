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
  `W:\x_posts_db\x-data.db`; override to use a platform-appropriate location
  (e.g. `~/.x-api-mcp/x-data.db`).

Set these via your shell environment or a local `.env` file (ignored by git).

OAuth 2.0 user tokens (for `x_get_bookmarks` and friends) are stored at
`~/.x-tokens.json` after running `x_authorize`. This file is also gitignored
and should never be committed.

## Further documentation

- [`INSTRUCTIONS.md`](./INSTRUCTIONS.md) — detailed usage, tool reference, and
  operational notes.
- [`dev_roadmap.md`](./dev_roadmap.md) — development roadmap and planned
  features.

## License

MIT — see [`LICENSE`](./LICENSE) for the full text.
