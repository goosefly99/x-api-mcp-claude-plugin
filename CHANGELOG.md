# Changelog

All notable changes to `x-api-mcp` are documented here.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/),
and this project follows semver pre-1.0 conventions (minor = feature,
patch = bugfix).

## [0.4.0] — 2026-04-20

Phase 2a handler-layer hardening.  Addresses spec-4a2c91e7: article-resolution
failures must never drop parent tweet rows, resource leaks in the Playwright
crawler must be observable, and the tool-handler surface must expose a stable
`TweetArticlesEnvelope` contract callers can validate against.

### Added
- **Handler-layer failure-isolation wrapper** (`services/handlerWrapper.ts`).
  New `withFailureIsolation<T>(name, tweetCount, fn, opts?)` wraps each
  tool handler's call to `resolveArticlesForTweets` in a soft-timeout race
  (default 15 000 ms) and a try/catch.  A thrown error or timeout resolves
  to `null` rather than bubbling up to the MCP client — the parent tweet
  upsert always runs regardless.  Every call emits a structured JSON
  stderr metric row:
  ```
  { plugin:'x-api', tool, articles_attempted, articles_succeeded,
    articles_timed_out, articles_failed, elapsed_ms }
  ```
- **`PLAYWRIGHT_SOFT_TIMEOUT_WIN` resource-leak canary**
  (`services/articleIngestService.ts`).  When the per-article soft timeout
  wins the race against the resolver — indicating a Playwright session we
  cannot cancel mid-flight — the service emits a structured stderr JSON
  line operators can correlate over time to detect browser-context
  accumulation:
  ```
  { plugin:'x-api', error_code:'PLAYWRIGHT_SOFT_TIMEOUT_WIN',
    open_sockets_count, browser_context_id, tweet_id, elapsed_ms }
  ```
  The `browser_context_id` is a coarse `ctx-N` monotonic counter sourced
  from `crawler.ts` (`getBrowserContextId()`); a true Chromium session
  GUID is deferred to v0.5.0 pending upstream playwright-core support.
  `open_sockets_count` is a `os.networkInterfaces()` proxy — netstat
  parsing for accurate counts is also deferred to v0.5.0.
- **`tweetArticlesEnvelopeSchema` zod schema** (exported from `types.ts`).
  Callers can now validate envelope responses at runtime with
  `tweetArticlesEnvelopeSchema.parse(envelope)` or `.safeParse(envelope)`.
  Paired with `articleResolutionSchema` (exported from
  `services/articleTypes.ts`) so per-article shape can be validated
  independently.

### Changed
- **`TweetArticlesEnvelope` reconciled to an array shape.**
  The envelope returned by `resolveArticlesForTweets` and
  `articleIngestService.ingestForTweets` is now
  `Array<{ tweetId: string; articles: ArticleResolution[] }>` rather than
  `Map<string, ArticleResolution[]>`.  Array order matches the input
  tweet order.  All five tweet-returning tool handlers (`x_get_tweet`,
  `x_get_user_tweets`, `x_get_bookmarks`, `x_search_tweets`,
  `x_get_thread`) updated to consume the array shape and build a local
  `articlesById` `Map` only where random-access lookup is needed for
  output formatting.  Callers that relied on the Map API
  (`.get`, `.size`) MUST migrate to `envelope.find(e => e.tweetId === id)`
  / `envelope.length`.

### Migration notes
- Existing callers passing a `Map` into consumer code will fail the new
  schema: `tweetArticlesEnvelopeSchema.safeParse(map).success === false`.
  The reconciliation is an intentional breaking change — the new shape
  is JSON-serializable, stable across module boundaries, and cheaper to
  log than a Map.
- The soft-timeout default remains 15 000 ms, configurable per-handler
  via the `softTimeoutMs` option on `withFailureIsolation`.  Existing
  handlers pass no option and inherit the default.

### Testing
- New `tests/tools/handler-wrapper.test.ts`: asserts the wrapper
  isolates thrown errors, persists the parent tweet row, and emits the
  canonical metric row on throw / timeout / success.
- New `tests/services/playwright-canary.test.ts`: asserts the canary
  is emitted exactly once per soft-timeout win, never on a clean
  resolver win, and that the required JSON fields are all truthy.
- Existing `tests/articleIngestService.spec.ts`,
  `tests/tweetArticlesJoin.spec.ts`, and
  `tests/toolsArticlesPlural.spec.ts` updated to the new array shape.

[0.4.0]: https://example.invalid/x-api-mcp/compare/v0.0.1...v0.4.0
