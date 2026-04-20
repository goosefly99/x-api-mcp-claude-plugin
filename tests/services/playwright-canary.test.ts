/**
 * v0.4.0 Component A — PLAYWRIGHT_SOFT_TIMEOUT_WIN canary contract.
 *
 * When the per-article soft timeout in articleIngestService wins the race
 * against the resolver, the service MUST emit a structured stderr JSON
 * canary line that operators can correlate over time to detect Playwright
 * context accumulation.
 *
 * Canary shape:
 *   {
 *     plugin: 'x-api',
 *     error_code: 'PLAYWRIGHT_SOFT_TIMEOUT_WIN',
 *     open_sockets_count: number,
 *     browser_context_id: string,
 *     tweet_id: string,
 *     elapsed_ms: number,
 *   }
 *
 * Strategy: drive articleIngestService with a never-resolving resolver and
 * a fast softTimeoutMs (50ms) so the test completes quickly.  Spy on
 * `process.stderr.write`, filter for the canary row, and assert the
 * required fields are all truthy and correctly typed.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { articleIngestService } from '../../services/articleIngestService.ts'
import type {
  ArticleResolution,
  DetectableTweet,
  ResolveArticleForTweet,
} from '../../services/articleIngestService.ts'

function makeFakeDb(): Database.Database {
  return {
    prepare: () => ({
      get: () => undefined,
      run: () => {},
    }),
  } as unknown as Database.Database
}

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

function parseCanaryRows(writeSpy: ReturnType<typeof vi.spyOn>): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const call of writeSpy.mock.calls) {
    const arg = call[0]
    if (typeof arg !== 'string') continue
    const trimmed = arg.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const row = JSON.parse(trimmed) as Record<string, unknown>
      if (row.error_code === 'PLAYWRIGHT_SOFT_TIMEOUT_WIN') {
        rows.push(row)
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }
  return rows
}

describe('PLAYWRIGHT_SOFT_TIMEOUT_WIN canary (Component A)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('emits a structured canary line on soft-timeout win', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    // A resolver that never resolves — guarantees the soft timeout wins.
    const neverResolves: ResolveArticleForTweet = vi.fn(
      () => new Promise<ArticleResolution[]>(() => { /* never */ }),
    )

    const service = articleIngestService({
      concurrency: 1,
      resolver: neverResolves,
      timeoutMs: 50, // fast softTimeout so the test finishes quickly
    })

    const results = await service.ingestForTweets(makeFakeDb(), makeTweets(1))

    // Envelope still populated — timeout path maps to failed/timeout, not drop.
    expect(results).toHaveLength(1)
    expect(results[0].articles).toHaveLength(1)
    expect(results[0].articles[0].status).toBe('failed')
    expect(results[0].articles[0].reason).toBe('timeout')

    const canaries = parseCanaryRows(writeSpy)
    expect(canaries).toHaveLength(1)

    const canary = canaries[0]
    expect(canary.plugin).toBe('x-api')
    expect(canary.error_code).toBe('PLAYWRIGHT_SOFT_TIMEOUT_WIN')

    // Truthy + correctly typed — we don't pin exact values because both the
    // proxy (os.networkInterfaces().length) and the context id ('unknown'
    // when no browser context is live in-test) vary by environment.
    expect(typeof canary.open_sockets_count).toBe('number')
    expect(canary.open_sockets_count).toBeTruthy()
    expect(typeof canary.browser_context_id).toBe('string')
    expect(canary.browser_context_id).toBeTruthy()

    expect(canary.tweet_id).toBe('tweet_0')
    expect(typeof canary.elapsed_ms).toBe('number')
    expect(canary.elapsed_ms as number).toBeGreaterThanOrEqual(0)
  })

  it('does not emit the canary when the resolver wins the race', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const fastResolver: ResolveArticleForTweet = vi.fn(async (_db, tweet) => [
      {
        status: 'ok' as const,
        url: `https://substack.com/${(tweet as { id: string }).id}`,
        article_id: (tweet as { id: string }).id,
      },
    ])

    const service = articleIngestService({
      concurrency: 1,
      resolver: fastResolver,
      timeoutMs: 10_000, // much larger than the resolver's near-zero latency
    })

    const results = await service.ingestForTweets(makeFakeDb(), makeTweets(2))

    expect(results).toHaveLength(2)
    for (const { articles } of results) {
      expect(articles).toHaveLength(1)
      expect(articles[0].status).toBe('ok')
    }

    const canaries = parseCanaryRows(writeSpy)
    expect(canaries).toHaveLength(0)
  })

  it('emits one canary line per tweet that hits the soft-timeout', async () => {
    const writeSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)

    const neverResolves: ResolveArticleForTweet = vi.fn(
      () => new Promise<ArticleResolution[]>(() => { /* never */ }),
    )

    const service = articleIngestService({
      concurrency: 4,
      resolver: neverResolves,
      timeoutMs: 40,
    })

    const results = await service.ingestForTweets(makeFakeDb(), makeTweets(3))

    expect(results).toHaveLength(3)

    const canaries = parseCanaryRows(writeSpy)
    expect(canaries).toHaveLength(3)

    // Each canary corresponds to one tweet id, exactly once.
    const tweetIds = new Set(canaries.map((c) => c.tweet_id))
    expect(tweetIds).toEqual(new Set(['tweet_0', 'tweet_1', 'tweet_2']))
  })
})
