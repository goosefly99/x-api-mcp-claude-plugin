import { xApiRequest, formatTweet, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XTweet } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertTweets } from '../db/repos/tweets.ts'
import { resolveArticlesForTweets, formatArticleLine, type ArticleResolution } from '../services/auto-crawl.ts'

export async function handleSearchTweets(args: Record<string, unknown>) {
  const query = args.query as string
  if (!query) throw new Error('query is required')

  const maxResults = Math.max(10, Math.min(100, Number(args.max_results) || 10))
  const nextToken = args.next_token as string | undefined
  const autoCrawl = args.auto_crawl_articles !== false

  const params: Record<string, string | undefined> = {
    query,
    max_results: String(maxResults),
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
    next_token: nextToken,
  }

  const { response, rateLimit } = await xApiRequest<XTweet[]>(
    'tweets/search/recent',
    params,
    'app'
  )

  if (!response.data || response.data.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No tweets found for query: "${query}"` }],
    }
  }

  const db = getDb()
  // TODO(X4): Surface all elements of articles[] in the tool response.
  let articleMap = new Map<string, ArticleResolution[]>()
  if (autoCrawl) {
    try {
      articleMap = await resolveArticlesForTweets(db, response.data)
    } catch (err) {
      process.stderr.write(`x-api: auto-crawl failed (search): ${err}\n`)
    }
  }

  const statusMap = new Map<string, string>()
  for (const [id, res] of articleMap) {
    if (res.length > 0) statusMap.set(id, res[0].status)
  }

  try {
    upsertTweets(db, response.data, response.includes, 'search', statusMap)
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (search): ${err}\n`)
  }

  const formatted = response.data
    .map((t) => {
      const first = articleMap.get(t.id)?.[0]
      const line = first ? `\n${formatArticleLine(first)}` : ''
      return `${formatTweet(t, response.includes)}${line}`
    })
    .join('\n\n')
  const pagination = response.meta?.next_token
    ? `\n\n--- More results available. Use next_token: "${response.meta.next_token}" ---`
    : ''
  const rateLimitInfo = `\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{
      type: 'text' as const,
      text: `Found ${response.meta?.result_count ?? response.data.length} tweets:\n\n${formatted}${pagination}${rateLimitInfo}`,
    }],
  }
}
