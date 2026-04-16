# Crawler Integration Decision (Task X0)

**Status:** Accepted — gate for Phase 2 (X1–X6).
**Date:** 2026-04-15.

## Context

When any of the five tweet-returning tools (`x_get_tweet`, `x_get_user_tweets`,
`x_get_thread`, `x_get_bookmarks`, `x_search_tweets`) returns a tweet that
links to an X Article or a qualifying external article host, x-api-mcp
hydrates the article body server-side and writes it to the `articles`
table. Today this is orchestrated by `services/auto-crawl.ts`, which calls
`crawlArticle(url)` from `crawler.ts` — a Playwright-driven scraper that
reuses a persistent Chromium profile under `~/.x-api-mcp/chrome-profile`.
Phase 2 introduces a concurrency-capped `articleIngestService` with soft
timeouts and a `tweet_articles` join, so we must lock in *how* the ingest
service reaches the crawler before that work begins.

## Options

### (a) Direct library import (status quo)
`articleIngestService` imports `crawlArticle` from `crawler.ts` and awaits
it. Everything runs in the x-api-mcp process; the browser context is a
module-level singleton shared across tool handlers. This is what the code
does today.

### (b) Managed subprocess
x-api-mcp spawns the crawler as a child Node process (or a long-lived
worker) and talks to it via stdio/IPC. The browser lives entirely in the
child; the parent sends `{url}` and receives `{content, author,
loginRequired}`. On crash the parent restarts the child.

### (c) Server-to-server MCP call
A separate `crawler-mcp` server owns the browser. x-api-mcp holds an MCP
client and calls `crawler.crawl_article` over the MCP transport. No such
sibling server exists in the repo today — this option would require
standing one up.

## Trade-offs

| Axis               | (a) Direct import            | (b) Subprocess                  | (c) MCP server                        |
|--------------------|------------------------------|---------------------------------|---------------------------------------|
| Latency            | Lowest — in-process call     | +IPC round-trip (~1–5 ms)       | +MCP round-trip (~10–50 ms)           |
| Failure isolation  | Weakest — Playwright crash/OOM takes x-api-mcp down | Strong — child dies, parent recovers | Strongest — separate process + supervisor |
| Shared state       | Shared browser context + Chrome profile free | Requires passing profile path to child; still single writer | Same Chrome profile must be owned by *one* server; contention risk if both run |
| Ease of deploy     | One process, no extra config | One repo, spawn-on-start        | New server, new MCP registration, new lifecycle |
| Testability        | Easiest — stub `crawlArticle` directly | Medium — mock IPC layer  | Hardest — must mock MCP transport     |
| Matches code today | Yes                          | No — new IPC layer              | No — new server + client              |

## Recommendation

**Adopt option (a): direct library import, with Phase 2 hardening.**
Rationale: (1) it is what ships today and the failure modes flagged by the
round-2 critic — Playwright hangs and sporadic errors — are addressable
in-process via the concurrency cap (X1) and soft timeout (X2) without
paying the deploy/lifecycle cost of a second server; (2) the persistent
Chrome profile is a single-writer resource, and running it in one process
avoids cross-process locking on cookies/session state; (3) there is no
`crawler-mcp` sibling in the repo, so option (c) is a net-new server we
would have to build before Phase 2 can start, which violates the
blocking-gate timeline. We revisit if post-launch telemetry shows crawler
faults crashing the parent process.

## Consequences for X1–X6

- **X1 (articleIngestService + concurrency cap):** service calls
  `crawlArticle` directly; concurrency cap is an in-process semaphore, not
  an IPC queue.
- **X2 (15 s soft timeout):** implemented via `Promise.race` in-process; no
  subprocess kill-signal plumbing required.
- **X3 (`tweet_articles` join + `articles[]` envelope):** unaffected — pure
  schema/envelope work.
- **X4 (wire 5 tools):** each handler imports the ingest service; no MCP
  client wiring.
- **X5 (`x_get_article` cache-read-only) / X6 (`x_crawl_article` manual
  override):** unaffected; both remain thin wrappers over the same
  in-process crawler.
- **Future reversal:** if we later move to (b) or (c), the change is
  localized to `articleIngestService` — tool handlers never see the
  transport.
