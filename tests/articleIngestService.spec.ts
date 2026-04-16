/**
 * TDD spec for articleIngestService — peak-concurrency assertion.
 *
 * Strategy:
 *   - Provide 12 tweets, each with a unique article URL.
 *   - Mock crawlArticle so each call takes ~20 ms and increments / decrements
 *     a shared `inFlight` counter.
 *   - After the run, assert peakInFlight <= concurrency cap (4).
 *   - Also assert that all 12 results were produced (no drops).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { DetectableTweet } from '../services/auto-crawl.ts'

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
  } as unknown as import('better-sqlite3').Database
}

// ── Mock crawlArticle ────────────────────────────────────────────────────────

// We mock the module BEFORE importing the service so Vitest replaces the
// module factory reference that articleIngestService holds.
vi.mock('../crawler.ts', () => {
  return {
    crawlArticle: vi.fn(),
  }
})

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
    const { crawlArticle } = await import('../crawler.ts')
    const mockedCrawl = vi.mocked(crawlArticle)

    let inFlight = 0
    let peakInFlight = 0

    mockedCrawl.mockImplementation(async (_url: string) => {
      inFlight++
      if (inFlight > peakInFlight) peakInFlight = inFlight
      // Simulate async work (~20 ms)
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      inFlight--
      return { content: 'x'.repeat(100), loginRequired: false }
    })

    const { articleIngestService } = await import('../services/articleIngestService.ts')
    const db = makeFakeDb()
    const service = articleIngestService({ concurrency: 4 })
    const results = await service.ingestForTweets(db, makeTweets(12))

    expect(peakInFlight).toBeGreaterThan(1) // actually parallelized
    expect(peakInFlight).toBeLessThanOrEqual(4) // cap respected
    expect(results.size).toBe(12) // all tweets processed
  })

  it('defaults to concurrency 4 when no option is supplied', async () => {
    const { crawlArticle } = await import('../crawler.ts')
    const mockedCrawl = vi.mocked(crawlArticle)

    let inFlight = 0
    let peakInFlight = 0

    mockedCrawl.mockImplementation(async (_url: string) => {
      inFlight++
      if (inFlight > peakInFlight) peakInFlight = inFlight
      await new Promise<void>((resolve) => setTimeout(resolve, 20))
      inFlight--
      return { content: 'x'.repeat(100), loginRequired: false }
    })

    const { articleIngestService } = await import('../services/articleIngestService.ts')
    const db = makeFakeDb()
    const service = articleIngestService() // no concurrency arg
    const results = await service.ingestForTweets(db, makeTweets(12))

    expect(peakInFlight).toBeLessThanOrEqual(4)
    expect(results.size).toBe(12)
  })

  it('handles crawl failures without dropping the tweet from results', async () => {
    const { crawlArticle } = await import('../crawler.ts')
    const mockedCrawl = vi.mocked(crawlArticle)

    mockedCrawl.mockRejectedValue(new Error('network error'))

    const { articleIngestService } = await import('../services/articleIngestService.ts')
    const db = makeFakeDb()
    const service = articleIngestService({ concurrency: 4 })
    const results = await service.ingestForTweets(db, makeTweets(4))

    expect(results.size).toBe(4)
    for (const [, res] of results) {
      // either failed or missing (if URL was not detected from mock text)
      expect(['failed', 'missing']).toContain(res.status)
    }
  })

  it('skips crawl for URLs already in the DB', async () => {
    const { crawlArticle } = await import('../crawler.ts')
    const mockedCrawl = vi.mocked(crawlArticle)
    mockedCrawl.mockResolvedValue({ content: 'x'.repeat(100), loginRequired: false })

    // Build a DB that already has all articles
    const db = makeFakeDb()
    // Pre-populate articles table via a fake crawl pass to seed the set
    for (let i = 0; i < 4; i++) {
      ;(db.prepare('INSERT OR REPLACE').run as unknown as (r: { url: string; id: string }) => void)(
        { url: `https://substack.com/article/${i}`, id: `https://substack.com/article/${i}` },
      )
    }

    const { articleIngestService } = await import('../services/articleIngestService.ts')
    const service = articleIngestService({ concurrency: 4 })
    await service.ingestForTweets(db, makeTweets(4))

    // crawlArticle should NOT have been called since all URLs are already in DB
    expect(mockedCrawl).not.toHaveBeenCalled()
  })
})
