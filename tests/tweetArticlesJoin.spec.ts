/**
 * TDD spec for X3 — `tweet_articles` one-to-many join table.
 *
 * A tweet can link multiple articles via distinct expanded_urls. After the
 * refactor:
 *   - `detectArticleUrls(tweet)` returns ALL article-like URLs (plural).
 *   - `resolveArticlesForTweet(db, tweet)` returns `ArticleResolution[]`,
 *     one entry per URL.
 *   - `resolveArticlesForTweets(db, tweets)` returns a
 *     `TweetArticlesEnvelope` — array of `{ tweetId, articles }` entries.
 *   - One `tweet_articles` row is persisted per URL resolution.
 *
 * This spec uses a real in-memory SQLite DB (better-sqlite3) so we can
 * assert on actual `tweet_articles` rows, which is the contract we care
 * about. The crawler is stubbed out via a mock resolver so the test
 * stays deterministic and offline.
 */

import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import { initSchema } from '../db/schema.ts'
import {
  detectArticleUrls,
  resolveArticlesForTweet,
  resolveArticlesForTweets,
} from '../services/auto-crawl.ts'
import { articleIngestService } from '../services/articleIngestService.ts'
import type { ArticleResolution, ResolveArticleForTweet } from '../services/articleIngestService.ts'
import { getTweetArticles } from '../db/repos/articles.ts'
import type { DetectableTweet } from '../services/articleTypes.ts'
import type { XTweet } from '../types.ts'

function makeInMemoryDb(): Database.Database {
  const db = new Database(':memory:')
  initSchema(db)
  return db
}

function tweetWithTwoArticleUrls(): XTweet {
  return {
    id: 'tweet_multi',
    text: 'Two great reads today: https://t.co/a https://t.co/b',
    entities: {
      urls: [
        {
          start: 22,
          end: 35,
          url: 'https://t.co/a',
          expanded_url: 'https://substack.com/article/alpha',
          display_url: 'substack.com/article/alpha',
        },
        {
          start: 36,
          end: 49,
          url: 'https://t.co/b',
          expanded_url: 'https://medium.com/@x/beta',
          display_url: 'medium.com/@x/beta',
        },
      ],
    },
  }
}

describe('X3: tweet_articles one-to-many join + articles[] envelope', () => {
  it('detectArticleUrls returns all qualifying URLs (plural)', () => {
    const tweet = tweetWithTwoArticleUrls()
    const urls = detectArticleUrls(tweet as DetectableTweet)
    expect(urls).toHaveLength(2)
    expect(urls).toContain('https://substack.com/article/alpha')
    expect(urls).toContain('https://medium.com/@x/beta')
  })

  it('migration creates tweet_articles table (idempotent)', () => {
    const db = makeInMemoryDb()
    // initSchema includes the new migration. Calling again must not throw.
    initSchema(db)

    const row = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='tweet_articles'",
      )
      .get() as { name: string } | undefined
    expect(row?.name).toBe('tweet_articles')

    // Columns
    const cols = db
      .prepare('PRAGMA table_info(tweet_articles)')
      .all() as Array<{ name: string }>
    const names = cols.map((c) => c.name).sort()
    expect(names).toEqual(
      ['article_id', 'failure_reason', 'status', 'tweet_id', 'url'].sort(),
    )
  })

  it('resolveArticlesForTweets persists one tweet_articles row per URL and returns ArticleResolution[] per tweet', async () => {
    const db = makeInMemoryDb()
    const tweet = tweetWithTwoArticleUrls()

    // Seed articles so the resolver takes the "already-exists" branch — this
    // avoids hitting the real crawler and keeps the test offline/fast.
    const now = new Date().toISOString()
    const insertArticle = db.prepare(`
      INSERT INTO articles (id, tweet_id, author_id, author_username, content, source, url, saved_at)
      VALUES (@id, NULL, NULL, NULL, @content, 'crawl', @url, @saved_at)
    `)
    insertArticle.run({
      id: 'https://substack.com/article/alpha',
      content: 'alpha content',
      url: 'https://substack.com/article/alpha',
      saved_at: now,
    })
    insertArticle.run({
      id: 'https://medium.com/@x/beta',
      content: 'beta content',
      url: 'https://medium.com/@x/beta',
      saved_at: now,
    })

    const envelope = await resolveArticlesForTweets(db, [tweet as DetectableTweet])

    // (b) Envelope: TweetArticlesEnvelope — array of { tweetId, articles }
    expect(Array.isArray(envelope)).toBe(true)
    const entry = envelope.find((e) => e.tweetId === 'tweet_multi')
    expect(entry).toBeDefined()
    const resolutions = entry!.articles
    expect(Array.isArray(resolutions)).toBe(true)
    expect(resolutions).toHaveLength(2)
    expect(resolutions.every((r) => r.status === 'ok')).toBe(true)

    // (a) 2 tweet_articles rows in DB
    const joinRows = getTweetArticles(db, 'tweet_multi')
    expect(joinRows).toHaveLength(2)
    const urls = joinRows.map((r) => r.url).sort()
    expect(urls).toEqual(
      ['https://medium.com/@x/beta', 'https://substack.com/article/alpha'].sort(),
    )
    for (const r of joinRows) {
      expect(r.tweet_id).toBe('tweet_multi')
      expect(r.status).toBe('ok')
      expect(r.failure_reason).toBeNull()
    }
  })

  it('resolveArticlesForTweet returns [{ status: "missing" }] for a tweet with no article URLs', async () => {
    const db = makeInMemoryDb()
    const tweet: XTweet = {
      id: 'tweet_plain',
      text: 'Just a normal tweet with no links.',
    }
    const results = await resolveArticlesForTweet(db, tweet as DetectableTweet)
    expect(results).toHaveLength(1)
    expect(results[0].status).toBe('missing')
  })

  it('envelope returns articles: Article[] (plural) — a tweet with 2 expanded_urls yields 2 resolutions', async () => {
    const db = makeInMemoryDb()
    const tweet = tweetWithTwoArticleUrls()

    // Pre-seed articles (skip the real crawler path).
    const now = new Date().toISOString()
    db.prepare(`
      INSERT INTO articles (id, tweet_id, author_id, author_username, content, source, url, saved_at)
      VALUES (@id, NULL, NULL, NULL, 'x', 'crawl', @url, @saved_at)
    `).run({ id: 'https://substack.com/article/alpha', url: 'https://substack.com/article/alpha', saved_at: now })
    db.prepare(`
      INSERT INTO articles (id, tweet_id, author_id, author_username, content, source, url, saved_at)
      VALUES (@id, NULL, NULL, NULL, 'x', 'crawl', @url, @saved_at)
    `).run({ id: 'https://medium.com/@x/beta', url: 'https://medium.com/@x/beta', saved_at: now })

    const envelope = await resolveArticlesForTweets(db, [tweet as DetectableTweet])
    const articles = envelope.find((e) => e.tweetId === 'tweet_multi')!.articles
    expect(articles).toHaveLength(2)
    // Shape: each element is an ArticleResolution with an article_id
    for (const a of articles) {
      expect(a.status).toBe('ok')
      expect(a.article_id).toBeDefined()
      expect(a.url).toBeDefined()
    }
  })

  it('mixed ok/failed: URL-1 resolves ok, URL-2 resolves failed — tweet_articles has 2 rows with correct statuses', async () => {
    const db = makeInMemoryDb()
    const tweet = tweetWithTwoArticleUrls()
    const url1 = 'https://substack.com/article/alpha'
    const url2 = 'https://medium.com/@x/beta'

    // Mock resolver: returns ok for url1, failed for url2
    const mockResolver: ResolveArticleForTweet = async (_db, _tweet) => {
      return [
        { status: 'ok', url: url1, article_id: url1 } satisfies ArticleResolution,
        { status: 'failed', url: url2, reason: 'network error' } satisfies ArticleResolution,
      ]
    }

    const service = articleIngestService({ concurrency: 4, resolver: mockResolver })
    const envelope = await service.ingestForTweets(db, [tweet as DetectableTweet])

    // (1) Envelope has 2 resolutions for the tweet
    const entry = envelope.find((e) => e.tweetId === 'tweet_multi')
    expect(entry).toBeDefined()
    const resolutions = entry!.articles
    expect(resolutions).toHaveLength(2)
    expect(resolutions[0].status).toBe('ok')
    expect(resolutions[1].status).toBe('failed')
    expect((resolutions[1] as { reason?: string }).reason).toBe('network error')

    // (2) Persist the resolutions to tweet_articles (mirrors resolveArticlesForTweets logic)
    const { insertTweetArticle } = await import('../db/repos/articles.ts')
    for (const r of resolutions) {
      if (r.status === 'missing') continue
      const url = r.url
      const articleId = r.article_id ?? url
      if (!url || !articleId) continue
      insertTweetArticle(
        db,
        'tweet_multi',
        articleId,
        url,
        r.status === 'ok' ? 'ok' : 'failed',
        (r as { reason?: string }).reason ?? null,
      )
    }

    // (3) tweet_articles has exactly 2 rows
    const joinRows = getTweetArticles(db, 'tweet_multi')
    expect(joinRows).toHaveLength(2)

    const row1 = joinRows.find((r) => r.url === url1)
    const row2 = joinRows.find((r) => r.url === url2)

    expect(row1).toBeDefined()
    expect(row1!.status).toBe('ok')
    expect(row1!.failure_reason).toBeNull()

    expect(row2).toBeDefined()
    expect(row2!.status).toBe('failed')
    expect(row2!.failure_reason).toBe('network error')
  })
})
