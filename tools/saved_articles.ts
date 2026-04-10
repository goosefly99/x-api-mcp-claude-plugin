import { getDb } from '../db/connection.ts'
import { queryArticles } from '../db/repos/articles.ts'
import type { ArticleRow } from '../db/types.ts'

const SNIPPET_LENGTH = 500

function formatSavedArticle(article: ArticleRow): string {
  const author = article.author_username ? `@${article.author_username}` : (article.author_id ?? 'unknown')
  const savedAt = new Date(article.saved_at).toLocaleDateString()
  const snippet = article.content
    ? article.content.length > SNIPPET_LENGTH
      ? `${article.content.slice(0, SNIPPET_LENGTH)}...`
      : article.content
    : '[no content]'

  const parts = [
    `--- Article ${article.id} ---`,
    `Author: ${author}`,
    `Source: ${article.source ?? 'unknown'} | Saved: ${savedAt}`,
    article.url ? `URL: ${article.url}` : '',
    '',
    snippet,
  ]

  return parts.filter(Boolean).join('\n')
}

export async function handleGetSavedArticles(args: Record<string, unknown>) {
  const query = args.query as string | undefined
  const author = args.author as string | undefined
  const source = args.source as 'api' | 'crawl' | undefined
  const limit = Math.max(1, Math.min(50, Number(args.limit) || 10))
  const offset = Math.max(0, Number(args.offset) || 0)

  let articles
  try {
    articles = queryArticles(getDb(), { query, author, source, limit, offset })
  } catch (err) {
    process.stderr.write(`x-api: DB query failed (get_saved_articles): ${err}\n`)
    return {
      content: [{ type: 'text' as const, text: 'Database query failed. The DB may not be initialized yet.' }],
    }
  }

  if (articles.length === 0) {
    const filters = [
      query ? `query="${query}"` : '',
      author ? `author="${author}"` : '',
      source ? `source="${source}"` : '',
    ].filter(Boolean).join(', ')
    const msg = filters ? `No saved articles found matching ${filters}.` : 'No saved articles found.'
    return {
      content: [{ type: 'text' as const, text: msg }],
    }
  }

  const formatted = articles.map(formatSavedArticle).join('\n\n')

  return {
    content: [{
      type: 'text' as const,
      text: `${articles.length} saved article(s) (offset ${offset}):\n\n${formatted}`,
    }],
  }
}
