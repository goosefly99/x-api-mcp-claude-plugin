import type Database from 'better-sqlite3'
import type { ArticleRow } from '../types.ts'

export interface ArticleInput {
  id: string
  tweet_id?: string | null
  author_id?: string | null
  author_username?: string | null
  content: string
  source: 'api' | 'crawl'
  url?: string | null
}

export interface QueryArticlesOpts {
  query?: string
  author?: string
  source?: 'api' | 'crawl'
  limit?: number
  offset?: number
}

/**
 * A row from the `tweet_articles` join table — one per (tweet, article) link.
 * Schema v5 introduced this table to model the one-to-many relationship
 * between a tweet and the articles it links to.
 */
export interface TweetArticleRow {
  tweet_id: string
  article_id: string
  url: string
  status: 'ok' | 'failed'
  failure_reason: string | null
}

/**
 * Upserts an article. The id is tweet_id for API articles, or URL for crawled articles.
 */
export function upsertArticle(db: Database.Database, article: ArticleInput): void {
  db.prepare(`
    INSERT OR REPLACE INTO articles (
      id, tweet_id, author_id, author_username, content, source, url, saved_at
    ) VALUES (
      @id, @tweet_id, @author_id, @author_username, @content, @source, @url, @saved_at
    )
  `).run({
    id: article.id,
    tweet_id: article.tweet_id ?? null,
    author_id: article.author_id ?? null,
    author_username: article.author_username ?? null,
    content: article.content,
    source: article.source,
    url: article.url ?? null,
    saved_at: new Date().toISOString(),
  })
}

/**
 * Query saved articles with optional filters.
 */
export function queryArticles(db: Database.Database, opts: QueryArticlesOpts = {}): ArticleRow[] {
  const { query, author, source, limit = 10, offset = 0 } = opts

  const conditions: string[] = []
  const params: unknown[] = []

  if (query) {
    conditions.push('content LIKE ?')
    params.push(`%${query}%`)
  }
  if (author) {
    conditions.push('author_username LIKE ?')
    params.push(`%${author}%`)
  }
  if (source) {
    conditions.push('source = ?')
    params.push(source)
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(limit, offset)

  return db.prepare(`
    SELECT * FROM articles
    ${where}
    ORDER BY saved_at DESC
    LIMIT ? OFFSET ?
  `).all(...params) as ArticleRow[]
}

// ── tweet_articles join table (schema v5) ───────────────────────────────────

/**
 * Upserts a single (tweet_id, article_id) link in the `tweet_articles`
 * join table.  Uses INSERT OR REPLACE so repeat ingestion is idempotent
 * and updates the status/failure_reason to the latest observed value.
 */
export function insertTweetArticle(
  db: Database.Database,
  tweetId: string,
  articleId: string,
  url: string,
  status: 'ok' | 'failed',
  failureReason: string | null = null,
): void {
  db.prepare(`
    INSERT OR REPLACE INTO tweet_articles (
      tweet_id, article_id, url, status, failure_reason
    ) VALUES (?, ?, ?, ?, ?)
  `).run(tweetId, articleId, url, status, failureReason)
}

/** Returns all tweet_articles rows for a given tweet_id, ordered by url. */
export function getTweetArticles(
  db: Database.Database,
  tweetId: string,
): TweetArticleRow[] {
  return db
    .prepare(
      'SELECT tweet_id, article_id, url, status, failure_reason FROM tweet_articles WHERE tweet_id = ? ORDER BY url',
    )
    .all(tweetId) as TweetArticleRow[]
}
