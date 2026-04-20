/**
 * v0.4.0 spec — TweetArticlesEnvelope return shape contract.
 *
 * Asserts:
 *  - `articleIngestService.ingestForTweets` returns an Array (not a Map).
 *  - `tweetArticlesEnvelopeSchema.parse(result)` succeeds for a valid envelope.
 *  - `tweetArticlesEnvelopeSchema.safeParse(map)` fails for a legacy
 *    `Map<tweetId, Article[]>` — catches regression if a call site accidentally
 *    re-introduces the Map shape.
 */

import { describe, it, expect, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { articleIngestService } from '../../services/articleIngestService.ts'
import type {
  ArticleResolution,
  DetectableTweet,
  ResolveArticleForTweet,
} from '../../services/articleIngestService.ts'
import { tweetArticlesEnvelopeSchema } from '../../types.ts'

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

describe('TweetArticlesEnvelope shape (v0.4.0)', () => {
  it('ingestForTweets returns Array.isArray(result) — not a Map', async () => {
    const mockResolver: ResolveArticleForTweet = vi.fn(async (_db, tweet) => [
      {
        status: 'ok' as const,
        url: `https://substack.com/${(tweet as { id: string }).id}`,
        article_id: (tweet as { id: string }).id,
      } satisfies ArticleResolution,
    ])

    const service = articleIngestService({ concurrency: 4, resolver: mockResolver })
    const result = await service.ingestForTweets(makeFakeDb(), makeTweets(3))

    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(3)
    // Negative: must NOT be a Map instance.
    expect(result).not.toBeInstanceOf(Map)
    // Positive shape: each entry has tweetId + articles[].
    for (const entry of result) {
      expect(typeof entry.tweetId).toBe('string')
      expect(Array.isArray(entry.articles)).toBe(true)
    }
  })

  it('tweetArticlesEnvelopeSchema.parse(result) does not throw', async () => {
    const mockResolver: ResolveArticleForTweet = vi.fn(async (_db, tweet) => [
      {
        status: 'ok' as const,
        url: `https://substack.com/${(tweet as { id: string }).id}`,
        article_id: (tweet as { id: string }).id,
      } satisfies ArticleResolution,
    ])

    const service = articleIngestService({ concurrency: 4, resolver: mockResolver })
    const result = await service.ingestForTweets(makeFakeDb(), makeTweets(2))

    // parse() throws on shape mismatch — wrapping in expect(...).not.toThrow()
    // is the contract-level assertion we care about.
    expect(() => tweetArticlesEnvelopeSchema.parse(result)).not.toThrow()

    // Parsed value should equal the input (shape-preserving).
    const parsed = tweetArticlesEnvelopeSchema.parse(result)
    expect(parsed).toHaveLength(2)
  })

  it('tweetArticlesEnvelopeSchema.safeParse(map) returns success=false for a legacy Map', () => {
    // Construct a legacy-shape Map to assert the schema rejects it.  This
    // catches regressions where a call site accidentally re-introduces the
    // Map return shape.
    const legacyMap = new Map<string, ArticleResolution[]>([
      [
        'tweet_0',
        [
          {
            status: 'ok',
            url: 'https://substack.com/tweet_0',
            article_id: 'tweet_0',
          } satisfies ArticleResolution,
        ],
      ],
    ])

    const result = tweetArticlesEnvelopeSchema.safeParse(legacyMap)
    expect(result.success).toBe(false)
  })

  it('schema validates an envelope with mixed ok/failed/missing statuses', () => {
    const envelope = [
      {
        tweetId: 'tweet_a',
        articles: [
          { status: 'ok' as const, url: 'https://x.com/a', article_id: 'a' },
          { status: 'failed' as const, url: 'https://x.com/b', reason: 'timeout' },
        ],
      },
      {
        tweetId: 'tweet_b',
        articles: [{ status: 'missing' as const }],
      },
    ]

    expect(() => tweetArticlesEnvelopeSchema.parse(envelope)).not.toThrow()
  })
})
