/**
 * TDD spec for X4 — plural articles[] surface in all 5 tweet-returning tool handlers.
 *
 * Strategy:
 *  - Test formatArticlesLines directly (unit).
 *  - For each of the 5 handlers, stub resolveArticlesForTweets + xApiRequest so
 *    we can assert the text output contains articles[1] / articles[2] entries
 *    without hitting the network or the DB.
 *
 * All 5 handlers:
 *   1. handleGetTweet         (tools/tweets.ts)
 *   2. handleGetUserTweets    (tools/tweets.ts)
 *   3. handleGetBookmarks     (tools/bookmarks.ts)
 *   4. handleSearchTweets     (tools/search.ts)
 *   5. handleGetThread        (tools/thread.ts)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ArticleResolution } from '../services/articleTypes.ts'
import { formatArticlesLines } from '../services/auto-crawl.ts'

// ── Unit tests for formatArticlesLines ──────────────────────────────────────

describe('formatArticlesLines', () => {
  it('returns empty string for empty array', () => {
    expect(formatArticlesLines([])).toBe('')
  })

  it('returns empty string for single missing entry', () => {
    expect(formatArticlesLines([{ status: 'missing' }])).toBe('')
  })

  it('formats a single ok resolution', () => {
    const result = formatArticlesLines([
      { status: 'ok', url: 'https://substack.com/a', article_id: 'https://substack.com/a' },
    ])
    expect(result).toBe('\n  articles[1]: ok url=https://substack.com/a id=https://substack.com/a')
  })

  it('formats two resolutions — ok then failed', () => {
    const resolutions: ArticleResolution[] = [
      { status: 'ok', url: 'https://substack.com/alpha', article_id: 'https://substack.com/alpha' },
      { status: 'failed', url: 'https://medium.com/beta', reason: 'login_required' },
    ]
    const result = formatArticlesLines(resolutions)
    expect(result).toContain('articles[1]: ok url=https://substack.com/alpha')
    expect(result).toContain('articles[2]: failed url=https://medium.com/beta reason=login_required')
  })

  it('formats a failed resolution without url or reason gracefully', () => {
    const result = formatArticlesLines([{ status: 'failed' }])
    expect(result).toBe('\n  articles[1]: failed')
  })

  it('formats a mixed array including a missing entry (multiple URLs)', () => {
    // A tweet with 3 URLs: ok, missing (odd edge case), failed
    const resolutions: ArticleResolution[] = [
      { status: 'ok', url: 'https://substack.com/a', article_id: 'https://substack.com/a' },
      { status: 'missing' },
      { status: 'failed', url: 'https://medium.com/b', reason: 'timeout' },
    ]
    const result = formatArticlesLines(resolutions)
    expect(result).toContain('articles[1]: ok')
    expect(result).toContain('articles[2]: missing')
    expect(result).toContain('articles[3]: failed')
  })
})

// ── Handler integration tests ────────────────────────────────────────────────
//
// We mock the two external calls each handler makes:
//   - ../client.ts  (xApiRequest)
//   - ../db/connection.ts  (getDb)
//   - ../db/repos/tweets.ts  (upsertTweets)
//   - ../services/auto-crawl.ts  (resolveArticlesForTweets)
//
// The mock articleMap is injected so we can assert on the text output.

const TWO_ARTICLE_MAP = new Map<string, ArticleResolution[]>([
  [
    'tweet_abc',
    [
      { status: 'ok', url: 'https://substack.com/alpha', article_id: 'https://substack.com/alpha' },
      { status: 'failed', url: 'https://medium.com/beta', reason: 'login_required' },
    ],
  ],
])

function makeBaseTweet(id = 'tweet_abc') {
  return {
    id,
    text: 'Two great reads https://t.co/a https://t.co/b',
    created_at: '2024-01-15T12:00:00.000Z',
    author_id: 'user_1',
  }
}

function makeApiResult<T>(data: T) {
  return {
    response: { data, includes: { users: [], tweets: [], media: [] }, meta: undefined },
    rateLimit: { remaining: 99, limit: 100, reset: 0 },
  }
}

// ── handleGetTweet ────────────────────────────────────────────────────────────

describe('handleGetTweet — plural articles in output', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes articles[1] and articles[2] in tool text for a tweet with 2 URLs', async () => {
    vi.doMock('../client.ts', () => ({
      xApiRequest: vi.fn().mockResolvedValue(makeApiResult(makeBaseTweet())),
      formatTweet: vi.fn().mockReturnValue('[tweet text]'),
      TWEET_FIELDS: '', USER_FIELDS: '', EXPANSIONS: '', MEDIA_FIELDS: '',
    }))
    vi.doMock('../db/connection.ts', () => ({ getDb: vi.fn().mockReturnValue({}) }))
    vi.doMock('../db/repos/tweets.ts', () => ({ upsertTweets: vi.fn() }))
    vi.doMock('../services/auto-crawl.ts', async () => {
      const actual = await vi.importActual('../services/auto-crawl.ts') as Record<string, unknown>
      return {
        ...actual,
        resolveArticlesForTweets: vi.fn().mockResolvedValue(TWO_ARTICLE_MAP),
      }
    })

    const { handleGetTweet } = await import('../tools/tweets.ts')
    const result = await handleGetTweet({ tweet_id: 'tweet_abc', auto_crawl_articles: true })
    const text = result.content[0].text

    expect(text).toContain('articles[1]: ok url=https://substack.com/alpha')
    expect(text).toContain('articles[2]: failed url=https://medium.com/beta reason=login_required')
    // Must NOT contain the old singular 'article:' key (without the index bracket)
    expect(text).not.toMatch(/\barticle: ok\b/)
    expect(text).not.toMatch(/\barticle: failed\b/)
  })
})

// ── handleGetUserTweets ───────────────────────────────────────────────────────

describe('handleGetUserTweets — plural articles in output', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes articles[1] and articles[2] per tweet in the output', async () => {
    const tweet = makeBaseTweet()
    vi.doMock('../client.ts', () => ({
      xApiRequest: vi.fn().mockResolvedValue(makeApiResult([tweet])),
      formatTweet: vi.fn().mockReturnValue('[tweet text]'),
      TWEET_FIELDS: '', USER_FIELDS: '', EXPANSIONS: '', MEDIA_FIELDS: '',
    }))
    vi.doMock('../db/connection.ts', () => ({ getDb: vi.fn().mockReturnValue({}) }))
    vi.doMock('../db/repos/tweets.ts', () => ({ upsertTweets: vi.fn() }))
    vi.doMock('../services/auto-crawl.ts', async () => {
      const actual = await vi.importActual('../services/auto-crawl.ts') as Record<string, unknown>
      return {
        ...actual,
        resolveArticlesForTweets: vi.fn().mockResolvedValue(TWO_ARTICLE_MAP),
      }
    })

    const { handleGetUserTweets } = await import('../tools/tweets.ts')
    const result = await handleGetUserTweets({ user_id: 'user_1', auto_crawl_articles: true })
    const text = result.content[0].text

    expect(text).toContain('articles[1]: ok url=https://substack.com/alpha')
    expect(text).toContain('articles[2]: failed url=https://medium.com/beta reason=login_required')
    expect(text).not.toMatch(/\barticle: ok\b/)
  })
})

// ── handleGetBookmarks ────────────────────────────────────────────────────────

describe('handleGetBookmarks — plural articles in output', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes articles[1] and articles[2] per bookmark in the output', async () => {
    const tweet = makeBaseTweet()
    vi.doMock('../client.ts', () => ({
      xApiRequest: vi.fn().mockResolvedValue(makeApiResult([tweet])),
      formatTweet: vi.fn().mockReturnValue('[bookmark text]'),
      TWEET_FIELDS: '', USER_FIELDS: '', EXPANSIONS: '', MEDIA_FIELDS: '',
    }))
    vi.doMock('../db/connection.ts', () => ({ getDb: vi.fn().mockReturnValue({}) }))
    vi.doMock('../db/repos/tweets.ts', () => ({ upsertTweets: vi.fn() }))
    vi.doMock('../services/auto-crawl.ts', async () => {
      const actual = await vi.importActual('../services/auto-crawl.ts') as Record<string, unknown>
      return {
        ...actual,
        resolveArticlesForTweets: vi.fn().mockResolvedValue(TWO_ARTICLE_MAP),
      }
    })

    const { handleGetBookmarks } = await import('../tools/bookmarks.ts')
    const result = await handleGetBookmarks({ auto_crawl_articles: true })
    const text = result.content[0].text

    expect(text).toContain('articles[1]: ok url=https://substack.com/alpha')
    expect(text).toContain('articles[2]: failed url=https://medium.com/beta reason=login_required')
    expect(text).not.toMatch(/\barticle: ok\b/)
  })
})

// ── handleSearchTweets ────────────────────────────────────────────────────────

describe('handleSearchTweets — plural articles in output', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes articles[1] and articles[2] per result tweet in the output', async () => {
    const tweet = makeBaseTweet()
    vi.doMock('../client.ts', () => ({
      xApiRequest: vi.fn().mockResolvedValue(makeApiResult([tweet])),
      formatTweet: vi.fn().mockReturnValue('[search tweet text]'),
      TWEET_FIELDS: '', USER_FIELDS: '', EXPANSIONS: '', MEDIA_FIELDS: '',
    }))
    vi.doMock('../db/connection.ts', () => ({ getDb: vi.fn().mockReturnValue({}) }))
    vi.doMock('../db/repos/tweets.ts', () => ({ upsertTweets: vi.fn() }))
    vi.doMock('../services/auto-crawl.ts', async () => {
      const actual = await vi.importActual('../services/auto-crawl.ts') as Record<string, unknown>
      return {
        ...actual,
        resolveArticlesForTweets: vi.fn().mockResolvedValue(TWO_ARTICLE_MAP),
      }
    })

    const { handleSearchTweets } = await import('../tools/search.ts')
    const result = await handleSearchTweets({ query: 'test', auto_crawl_articles: true })
    const text = result.content[0].text

    expect(text).toContain('articles[1]: ok url=https://substack.com/alpha')
    expect(text).toContain('articles[2]: failed url=https://medium.com/beta reason=login_required')
    expect(text).not.toMatch(/\barticle: ok\b/)
  })
})

// ── handleGetThread ───────────────────────────────────────────────────────────

describe('handleGetThread — plural articles in output', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('includes articles[1] and articles[2] per thread tweet in the output', async () => {
    const seedTweet = { ...makeBaseTweet(), conversation_id: 'conv_1' }
    // Two xApiRequest calls: 1st=seed, 2nd=search results
    vi.doMock('../client.ts', () => ({
      xApiRequest: vi.fn()
        .mockResolvedValueOnce({
          response: { data: seedTweet, includes: { users: [], tweets: [], media: [] } },
          rateLimit: { remaining: 99, limit: 100, reset: 0 },
        })
        .mockResolvedValueOnce({
          response: { data: [], includes: { users: [], tweets: [], media: [] }, meta: {} },
          rateLimit: { remaining: 98, limit: 100, reset: 0 },
        }),
      formatTweet: vi.fn().mockReturnValue('[thread tweet text]'),
      TWEET_FIELDS: '', USER_FIELDS: '', EXPANSIONS: '', MEDIA_FIELDS: '',
    }))
    vi.doMock('../db/connection.ts', () => ({ getDb: vi.fn().mockReturnValue({}) }))
    vi.doMock('../db/repos/tweets.ts', () => ({ upsertTweets: vi.fn() }))
    vi.doMock('../services/auto-crawl.ts', async () => {
      const actual = await vi.importActual('../services/auto-crawl.ts') as Record<string, unknown>
      return {
        ...actual,
        resolveArticlesForTweets: vi.fn().mockResolvedValue(TWO_ARTICLE_MAP),
      }
    })

    const { handleGetThread } = await import('../tools/thread.ts')
    const result = await handleGetThread({ tweet_id: 'tweet_abc', auto_crawl_articles: true })
    const text = result.content[0].text

    expect(text).toContain('articles[1]: ok url=https://substack.com/alpha')
    expect(text).toContain('articles[2]: failed url=https://medium.com/beta reason=login_required')
    expect(text).not.toMatch(/\barticle: ok\b/)
  })
})
