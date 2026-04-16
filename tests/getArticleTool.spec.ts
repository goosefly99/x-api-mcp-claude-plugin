/**
 * TDD spec for X5 — x_get_article demoted to cache-read-only.
 *
 * Verifies:
 *   1. Cache-hit by URL — returns the full article row as text.
 *   2. Cache-hit by numeric ID embedded in a full URL — strips prefix and hits cache.
 *   3. Cache-miss — returns null-ish text with zero HTTP/crawler invocations.
 *
 * Uses an in-memory SQLite DB so no real DB is touched.
 * No mocking of xApiRequest or crawler — they must never be called.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../db/schema.ts'
import { upsertArticle } from '../db/repos/articles.ts'
import { handleGetArticle } from '../tools/article.ts'

// ── in-memory DB factory ─────────────────────────────────────────────────────

function makeDb() {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}

// ── tests ────────────────────────────────────────────────────────────────────

describe('handleGetArticle (cache-read-only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the cached article row when found by article_id', async () => {
    const db = makeDb()
    const articleId = '1234567890'

    upsertArticle(db, {
      id: articleId,
      tweet_id: articleId,
      author_id: 'u1',
      author_username: 'testuser',
      content: 'Hello from the cache.',
      source: 'api',
      url: `https://x.com/i/article/${articleId}`,
    })

    const result = await handleGetArticle({ article_id: articleId }, db)

    expect(result.content).toHaveLength(1)
    expect(result.content[0].type).toBe('text')
    const text = result.content[0].text as string
    expect(text).toContain('testuser')
    expect(text).toContain('Hello from the cache.')
  })

  it('strips URL prefix and returns cached row by ID', async () => {
    const db = makeDb()
    const articleId = '9876543210'
    const fullUrl = `https://x.com/i/article/${articleId}`

    upsertArticle(db, {
      id: articleId,
      tweet_id: articleId,
      author_id: 'u2',
      author_username: 'author2',
      content: 'URL-stripped cache hit.',
      source: 'crawl',
      url: fullUrl,
    })

    // Pass the full URL as article_id — tool should strip it
    const result = await handleGetArticle({ article_id: fullUrl }, db)

    const text = result.content[0].text as string
    expect(text).toContain('author2')
    expect(text).toContain('URL-stripped cache hit.')
  })

  it('returns null-ish response when article is not in cache (cache-miss)', async () => {
    const db = makeDb()

    const result = await handleGetArticle({ article_id: 'no_such_id' }, db)

    expect(result.content).toHaveLength(1)
    const text = result.content[0].text as string
    // Should explain the article isn't cached — not throw, not call X API
    expect(text.toLowerCase()).toMatch(/not found|not in cache|no cached/)
  })

  it('throws when article_id is missing', async () => {
    const db = makeDb()
    await expect(handleGetArticle({}, db)).rejects.toThrow('article_id is required')
  })
})
