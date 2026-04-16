import type Database from 'better-sqlite3'
import { getDb } from '../db/connection.ts'
import { getArticleById, getArticleByUrl } from '../db/repos/articles.ts'

export async function handleGetArticle(
  args: Record<string, unknown>,
  db: Database.Database = getDb(),
) {
  let articleId = args.article_id as string
  if (!articleId) throw new Error('article_id is required')

  // Strip URL prefix if full URL provided (e.g. https://x.com/i/article/2039029453540532224)
  const urlMatch = articleId.match(/\/article\/(\d+)/)
  if (urlMatch) {
    articleId = urlMatch[1]
  }

  const row = getArticleById(db, articleId)
    ?? getArticleByUrl(db, `https://x.com/i/article/${articleId}`)

  if (!row) {
    return {
      content: [{
        type: 'text' as const,
        text: `Article ${articleId} not found in cache. Use x_crawl_article to fetch and store it first.`,
      }],
    }
  }

  const author = row.author_username ? `@${row.author_username}` : (row.author_id ?? 'unknown')
  const savedAt = new Date(row.saved_at).toLocaleDateString()
  const parts = [
    `--- Cached Article ${row.id} ---`,
    `Author: ${author}`,
    `Source: ${row.source ?? 'unknown'} | Saved: ${savedAt}`,
    row.url ? `URL: ${row.url}` : '',
    '',
    row.content ?? '[no content]',
  ]

  return {
    content: [{ type: 'text' as const, text: parts.filter(Boolean).join('\n') }],
  }
}
