import { crawlArticle, browserLogin } from '../crawler.ts'
import { getDb } from '../db/connection.ts'
import { upsertArticle } from '../db/repos/articles.ts'

// ── x_browser_login ──────────────────────────────────────────────

export async function handleBrowserLogin(
  _args: Record<string, unknown>,
) {
  const result = await browserLogin()

  return {
    content: [{ type: 'text' as const, text: result.message }],
    isError: !result.success,
  }
}

// ── x_crawl_article ──────────────────────────────────────────────

export async function handleCrawlArticle(
  args: Record<string, unknown>,
) {
  process.stderr.write('[x_crawl_article] manual override — not called by ingest pipeline\n')

  const input = args.url as string
  if (!input) throw new Error('url is required')

  // Normalise to a full URL
  let url: string
  if (input.startsWith('http')) {
    url = input
  } else {
    // Assume bare article ID
    const id = input.replace(/\D/g, '')
    if (!id) throw new Error(`Cannot parse article ID from: ${input}`)
    url = `https://x.com/i/article/${id}`
  }

  const result = await crawlArticle(url)

  if (result.loginRequired) {
    return {
      content: [{
        type: 'text' as const,
        text: 'Login required. Run x_browser_login first to authenticate with X in your browser.',
      }],
      isError: true,
    }
  }

  if (!result.content || result.content.length < 50) {
    return {
      content: [{
        type: 'text' as const,
        text: `Could not extract meaningful content from ${url}. The page may have an unexpected structure or require authentication.`,
      }],
      isError: true,
    }
  }

  // Persist crawled article to DB
  try {
    upsertArticle(getDb(), {
      id: url,
      tweet_id: null,
      author_id: null,
      author_username: result.author ?? null,
      content: result.content,
      source: 'crawl',
      url,
    })
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (crawl_article): ${err}\n`)
  }

  const parts = [
    `--- Article crawled from ${url} ---`,
    result.author ? `Author: ${result.author}` : '',
    '',
    result.content,
  ]

  return {
    content: [{ type: 'text' as const, text: parts.filter(Boolean).join('\n') }],
  }
}
