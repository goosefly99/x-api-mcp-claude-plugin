/**
 * v0.4.0 Component A — handlerWrapper failure-isolation contract.
 *
 * Asserts, end-to-end via the handler, that:
 *   1. A thrown error in resolveArticlesForTweets is isolated — the MCP
 *      response is still 2xx, the parent tweet is still upserted, and
 *      `articles[]` renders empty.
 *   2. A structured JSON metric row is emitted to stderr on every call,
 *      with the canonical shape
 *      { plugin:'x-api', tool, articles_attempted, articles_succeeded,
 *        articles_timed_out, articles_failed, elapsed_ms }.
 *   3. Article-resolution counters are tallied from the envelope when the
 *      resolver returns successfully (succeeded / timed_out / failed split).
 *
 * This test uses `handleGetTweet` as the representative handler — all five
 * tweet-returning handlers funnel through the same withFailureIsolation()
 * seam, so one handler integration test is sufficient to cover the
 * wrapper contract in situ.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { ArticleResolution } from '../../services/articleTypes.ts'

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeBaseTweet(id = 'tweet_abc') {
  return {
    id,
    text: 'A short tweet with no articles',
    created_at: '2026-04-20T12:00:00.000Z',
    author_id: 'user_1',
  }
}

function makeApiResult<T>(data: T) {
  return {
    response: { data, includes: { users: [], tweets: [], media: [] }, meta: undefined },
    rateLimit: { remaining: 99, limit: 100, reset: 0 },
  }
}

/**
 * Parse every JSON metric row written to stderr during the test.  Non-JSON
 * lines (e.g. the plain-text `x-api: handlerWrapper error ...` diagnostic
 * or `x-api: DB save failed ...`) are ignored.
 */
function parseMetricRows(writeSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const call of writeSpy.mock.calls) {
    const arg = call[0]
    if (typeof arg !== 'string') continue
    const trimmed = arg.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      rows.push(JSON.parse(trimmed) as Record<string, unknown>)
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return rows
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('handlerWrapper — failure isolation (Component A)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('isolates a thrown error in resolveArticlesForTweets — tweet still persists, MCP response is 2xx, metric row is emitted', async () => {
    const upsertSpy = vi.fn()
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    vi.doMock('../../client.ts', () => ({
      xApiRequest: vi.fn().mockResolvedValue(makeApiResult(makeBaseTweet())),
      formatTweet: vi.fn().mockReturnValue('[tweet text]'),
      TWEET_FIELDS: '', USER_FIELDS: '', EXPANSIONS: '', MEDIA_FIELDS: '',
    }))
    vi.doMock('../../db/connection.ts', () => ({ getDb: vi.fn().mockReturnValue({}) }))
    vi.doMock('../../db/repos/tweets.ts', () => ({ upsertTweets: upsertSpy }))
    vi.doMock('../../services/auto-crawl.ts', async () => {
      const actual = await vi.importActual('../../services/auto-crawl.ts') as Record<string, unknown>
      return {
        ...actual,
        resolveArticlesForTweets: vi.fn().mockRejectedValue(new Error('boom — crawler blew up')),
      }
    })

    const { handleGetTweet } = await import('../../tools/tweets.ts')
    const result = await handleGetTweet({ tweet_id: 'tweet_abc', auto_crawl_articles: true })

    // MCP response is shaped like a success (no throw, content array present).
    expect(result).toBeDefined()
    expect(result.content).toBeDefined()
    expect(result.content[0].type).toBe('text')

    // Parent tweet row was upserted — failure isolation preserves the core
    // data-landing guarantee the handler wrapper exists to protect.
    expect(upsertSpy).toHaveBeenCalledTimes(1)

    // At least one structured JSON metric row was emitted.  The wrapper
    // also emits a plain-text diagnostic on throw — we ignore that line.
    const rows = parseMetricRows(writeSpy)
    const metric = rows.find((r) => r.plugin === 'x-api' && r.tool === 'x_get_tweet')
    expect(metric).toBeDefined()
    expect(metric!.articles_attempted).toBe(1)
    // Throw path: attempted=1, failed=1, all others 0.
    expect(metric!.articles_succeeded).toBe(0)
    expect(metric!.articles_timed_out).toBe(0)
    expect(metric!.articles_failed).toBe(1)
    expect(typeof metric!.elapsed_ms).toBe('number')
    expect(metric!.elapsed_ms as number).toBeGreaterThanOrEqual(0)
  })

  it('emits a success metric row with envelope-based counters when the resolver returns a mixed envelope', async () => {
    const upsertSpy = vi.fn()
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    // Envelope with three tweets: one ok, one failed-timeout, one failed-other.
    // The wrapper should tally these into succeeded=1, timed_out=1, failed=1.
    const envelope = [
      {
        tweetId: 'tweet_a',
        articles: [{ status: 'ok' as const, url: 'https://substack.com/a', article_id: 'a' } satisfies ArticleResolution],
      },
      {
        tweetId: 'tweet_b',
        articles: [{ status: 'failed' as const, reason: 'timeout' } satisfies ArticleResolution],
      },
      {
        tweetId: 'tweet_c',
        articles: [{ status: 'failed' as const, reason: 'login_required' } satisfies ArticleResolution],
      },
    ]

    vi.doMock('../../client.ts', () => ({
      xApiRequest: vi.fn().mockResolvedValue(
        makeApiResult([
          { ...makeBaseTweet('tweet_a') },
          { ...makeBaseTweet('tweet_b') },
          { ...makeBaseTweet('tweet_c') },
        ]),
      ),
      formatTweet: vi.fn().mockReturnValue('[tweet text]'),
      TWEET_FIELDS: '', USER_FIELDS: '', EXPANSIONS: '', MEDIA_FIELDS: '',
    }))
    vi.doMock('../../db/connection.ts', () => ({ getDb: vi.fn().mockReturnValue({}) }))
    vi.doMock('../../db/repos/tweets.ts', () => ({ upsertTweets: upsertSpy }))
    vi.doMock('../../services/auto-crawl.ts', async () => {
      const actual = await vi.importActual('../../services/auto-crawl.ts') as Record<string, unknown>
      return {
        ...actual,
        resolveArticlesForTweets: vi.fn().mockResolvedValue(envelope),
      }
    })

    const { handleGetUserTweets } = await import('../../tools/tweets.ts')
    const result = await handleGetUserTweets({ user_id: 'user_1', auto_crawl_articles: true })

    expect(result.content[0].type).toBe('text')

    const rows = parseMetricRows(writeSpy)
    const metric = rows.find((r) => r.plugin === 'x-api' && r.tool === 'x_get_user_tweets')
    expect(metric).toBeDefined()
    expect(metric!.articles_attempted).toBe(3)
    expect(metric!.articles_succeeded).toBe(1)
    expect(metric!.articles_timed_out).toBe(1)
    expect(metric!.articles_failed).toBe(1)
    expect(typeof metric!.elapsed_ms).toBe('number')
  })

  it('withFailureIsolation returns null on thrown error (unit-level contract)', async () => {
    // Unit-level sanity check — the in-situ handler test above exercises
    // the full flow, but this test pins the `null` return contract directly
    // so regressions surface even without a tool-handler integration test.
    const { withFailureIsolation } = await import('../../services/handlerWrapper.ts')

    const result = await withFailureIsolation('test_tool', 3, async () => {
      throw new Error('explode')
    })

    expect(result).toBeNull()
  })

  it('withFailureIsolation returns null on soft timeout and emits a timeout-shaped metric row', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const { withFailureIsolation } = await import('../../services/handlerWrapper.ts')

    // Never-resolving fn — wrapper must time out and return null.
    const result = await withFailureIsolation(
      'test_tool',
      2,
      () => new Promise<unknown>(() => { /* never */ }),
      { softTimeoutMs: 20 },
    )

    expect(result).toBeNull()

    const rows = parseMetricRows(writeSpy)
    const metric = rows.find((r) => r.plugin === 'x-api' && r.tool === 'test_tool')
    expect(metric).toBeDefined()
    expect(metric!.articles_attempted).toBe(2)
    expect(metric!.articles_timed_out).toBe(2)
    expect(metric!.articles_succeeded).toBe(0)
    expect(metric!.articles_failed).toBe(0)
  })
})
