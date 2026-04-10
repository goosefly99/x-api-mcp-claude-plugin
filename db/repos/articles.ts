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
