/**
 * TDD spec for articleIngestService — peak-concurrency assertion.
 *
 * Strategy:
 *   - Provide 12 tweets, each with a unique article URL.
 *   - Inject a mock resolver that uses manually-resolved Promises to give
 *     explicit control over which task starts and completes. This eliminates
 *     real-time scheduling dependency and makes the concurrency test
 *     fully deterministic regardless of CI scheduler speed.
 *   - After the run, assert peakInFlight <= concurrency cap (4).
 *   - Also assert that all 12 results were produced (no drops).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { articleIngestService } from '../services/articleIngestService.ts'
import type { DetectableTweet, ArticleResolution, ResolveArticleForTweet } from '../services/articleIngestService.ts'
import type Database from 'better-sqlite3'

// ── Fake DB ──────────────────────────────────────────────────────────────────

function makeFakeDb() {
  const articles = new Set<string>()
  return {
    prepare: (sql: string) => {
      // SELECT 1 AS present FROM articles WHERE url = ?
      if (sql.includes('SELECT 1 AS present')) {
        return {
          get: (url: string) => (articles.has(url) ? { present: 1 } : undefined),
        }
      }
      // SELECT id FROM articles WHERE url = ?
      if (sql.includes('SELECT id')) {
        return {
          get: (url: string) => (articles.has(url) ? { id: url } : undefined),
        }
      }
      // INSERT OR REPLACE
      return {
        run: (row: { url?: string; id?: string }) => {
          const key = row.url ?? row.id
          if (key) articles.add(key)
        },
      }
    },
  } as unknown as Database.Database
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTweets(n: number): DetectableTweet[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `tweet_${i}`,
    text: `Check this out https://substack.com/article/${i}`,
    note_tweet: undefined,
    entities: {
      urls: [
        {
          expanded_url: `https://substack.com/article/${i}`,
          url: `https://t.co/fake${i}`,
        },
      ],
    },
  }))
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('articleIngestService', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('respects concurrency cap of 4 when processing 12 tweets', async () => {
    let inFlight = 0
    let peakInFlight = 0

    // Each task gets its own resolve handle so we control exactly when it finishes.
    const resolvers: Array<() => void> = []

    const mockResolver: ResolveArticleForTweet = vi.fn(async (_db, tweet) => {
      inFlight++
      if (inFlight > peakInFlight) peakInFlight = inFlight
      // Park here until the test explicitly unblocks this task.
      await new Promise<void>((resolve) => resolvers.push(resolve))
      inFlight--
      const id = (tweet as { id: string }).id
      return { status: 'ok', url: `https://substack.com/${id}`, article_id: id } satisfies ArticleResolution
    })

    const db = makeFakeDb()
    const service = articleIngestService({ concurrency: 4, resolver: mockResolver })

    // Start the ingestion but don't await yet — tasks park on their promises.
    const resultPromise = service.ingestForTweets(db, makeTweets(12))

    // Drain the microtask queue so tasks can start and reach their park point.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // With cap=4 and 12 tasks we expect exactly 4 tasks to be in-flight now.
    expect(peakInFlight).toBe(4)

    // Unblock all parked tasks one by one, letting the semaphore refill.
    while (resolvers.length > 0) {
      resolvers.shift()!()
      // Allow newly released tasks to acquire and park.
      await Promise.resolve()
      await Promise.resolve()
    }

    const results = await resultPromise

    expect(peakInFlight).toBe(4)           // cap was reached exactly
    expect(peakInFlight).toBeLessThanOrEqual(4) // cap was never exceeded
    expect(results.size).toBe(12)          // all tweets processed
  })

  it('defaults to concurrency 4 when no concurrency option is supplied', async () => {
    let inFlight = 0
    let peakInFlight = 0
    const resolvers: Array<() => void> = []

    const mockResolver: ResolveArticleForTweet = vi.fn(async (_db, tweet) => {
      inFlight++
      if (inFlight > peakInFlight) peakInFlight = inFlight
      await new Promise<void>((resolve) => resolvers.push(resolve))
      inFlight--
      const id = (tweet as { id: string }).id
      return { status: 'ok', url: `https://substack.com/${id}`, article_id: id } satisfies ArticleResolution
    })

    const db = makeFakeDb()
    // Omit concurrency — should default to 4.
    const service = articleIngestService({ resolver: mockResolver })

    const resultPromise = service.ingestForTweets(db, makeTweets(12))

    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    // Default cap is 4; exactly 4 tasks should be in-flight.
    expect(peakInFlight).toBe(4)

    while (resolvers.length > 0) {
      resolvers.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }

    const results = await resultPromise
    expect(peakInFlight).toBeLessThanOrEqual(4)
    expect(results.size).toBe(12)
  })

  it('handles resolver failures without dropping the tweet from results', async () => {
    const mockResolver: ResolveArticleForTweet = vi.fn(async () => {
      throw new Error('network error')
    })

    const db = makeFakeDb()
    const service = articleIngestService({ concurrency: 4, resolver: mockResolver })
    const results = await service.ingestForTweets(db, makeTweets(4))

    expect(results.size).toBe(4)
    for (const [, res] of results) {
      expect(res.status).toBe('failed')
      expect(res.reason).toBe('network error')
    }
  })

  it('returns missing when resolver returns missing status', async () => {
    const mockResolver: ResolveArticleForTweet = vi.fn(async () => ({
      status: 'missing' as const,
    }))

    const db = makeFakeDb()
    const service = articleIngestService({ concurrency: 4, resolver: mockResolver })
    const results = await service.ingestForTweets(db, makeTweets(4))

    expect(results.size).toBe(4)
    for (const [, res] of results) {
      expect(res.status).toBe('missing')
    }
  })

  // ── Timeout tests ──────────────────────────────────────────────────────────

  describe('soft-timeout per article crawl', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('marks article as failed with reason=timeout when resolver takes 30s (timeout=15s)', async () => {
      vi.useFakeTimers()

      // A resolver that never resolves (simulates a hung 30s crawl)
      const neverResolves: ResolveArticleForTweet = vi.fn(
        () => new Promise<ArticleResolution>(() => {/* intentionally never resolves */}),
      )

      const db = makeFakeDb()
      const service = articleIngestService({
        concurrency: 4,
        resolver: neverResolves,
        timeoutMs: 15_000,
      })

      const tweets = makeTweets(1)
      const resultPromise = service.ingestForTweets(db, tweets)

      // Advance fake timers by 15s to trigger the timeout
      await vi.advanceTimersByTimeAsync(15_000)

      const results = await resultPromise

      // Tweet row must still be in the output map (not dropped)
      expect(results.size).toBe(1)

      const res = results.get('tweet_0')!
      expect(res).toBeDefined()
      expect(res.status).toBe('failed')
      expect(res.reason).toBe('timeout')
    })

    it('does not time out a fast resolver (resolves before 15s)', async () => {
      vi.useFakeTimers()

      const fastResolver: ResolveArticleForTweet = vi.fn(async (_db, tweet) => ({
        status: 'ok' as const,
        url: `https://substack.com/${(tweet as { id: string }).id}`,
        article_id: (tweet as { id: string }).id,
      }))

      const db = makeFakeDb()
      const service = articleIngestService({
        concurrency: 4,
        resolver: fastResolver,
        timeoutMs: 15_000,
      })

      const resultPromise = service.ingestForTweets(db, makeTweets(2))

      // Advance only a little — fast resolver already resolved synchronously
      await vi.advanceTimersByTimeAsync(0)

      const results = await resultPromise

      expect(results.size).toBe(2)
      for (const [, res] of results) {
        expect(res.status).toBe('ok')
      }
    })

    it('defaults timeoutMs to 15000 when not supplied', async () => {
      vi.useFakeTimers()

      const neverResolves: ResolveArticleForTweet = vi.fn(
        () => new Promise<ArticleResolution>(() => {/* intentionally never resolves */}),
      )

      const db = makeFakeDb()
      // No timeoutMs — should default to 15_000
      const service = articleIngestService({ concurrency: 1, resolver: neverResolves })

      const resultPromise = service.ingestForTweets(db, makeTweets(1))
      await vi.advanceTimersByTimeAsync(15_000)

      const results = await resultPromise

      expect(results.size).toBe(1)
      expect(results.get('tweet_0')!.status).toBe('failed')
      expect(results.get('tweet_0')!.reason).toBe('timeout')
    })
  })

  it('skips already-resolved tweets correctly via resolver', async () => {
    const mockResolver: ResolveArticleForTweet = vi.fn(async (_db, tweet) => ({
      status: 'ok' as const,
      url: `https://substack.com/article/${(tweet as { id: string }).id}`,
      article_id: (tweet as { id: string }).id,
    }))

    const db = makeFakeDb()
    const service = articleIngestService({ concurrency: 4, resolver: mockResolver })
    const results = await service.ingestForTweets(db, makeTweets(4))

    expect(mockResolver).toHaveBeenCalledTimes(4)
    expect(results.size).toBe(4)
    for (const [, res] of results) {
      expect(res.status).toBe('ok')
    }
  })
})
