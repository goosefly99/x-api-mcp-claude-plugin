import { xApiRequest, formatTweet, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { TweetArticlesEnvelope, XTweet, XUser } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertTweets } from '../db/repos/tweets.ts'
import { resolveArticlesForTweets, formatArticlesLines, type ArticleResolution } from '../services/auto-crawl.ts'

let cachedUserId: string | null = null

async function getAuthenticatedUserId(): Promise<string> {
  if (cachedUserId) return cachedUserId

  const { response } = await xApiRequest<XUser>('users/me', {}, 'user')
  if (!response.data) throw new Error('Failed to get authenticated user info')

  cachedUserId = response.data.id
  return cachedUserId
}

export async function handleGetBookmarks(args: Record<string, unknown>) {
  const maxResults = Math.max(1, Math.min(100, Number(args.max_results) || 20))
  const nextToken = args.next_token as string | undefined
  const autoCrawl = args.auto_crawl_articles !== false

  const userId = await getAuthenticatedUserId()

  // Note: bookmarks endpoint uses pagination_token, not next_token
  const params: Record<string, string | undefined> = {
    max_results: String(maxResults),
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
    pagination_token: nextToken,
  }

  const { response, rateLimit } = await xApiRequest<XTweet[]>(
    `users/${userId}/bookmarks`,
    params,
    'user'
  )

  if (!response.data || response.data.length === 0) {
    return {
      content: [{ type: 'text' as const, text: 'No bookmarks found.' }],
    }
  }

  const db = getDb()
  let articleEnvelope: TweetArticlesEnvelope = []
  if (autoCrawl) {
    try {
      articleEnvelope = await resolveArticlesForTweets(db, response.data)
    } catch (err) {
      process.stderr.write(`x-api: auto-crawl failed (bookmarks): ${err}\n`)
    }
  }

  const articlesById = new Map<string, ArticleResolution[]>()
  const statusMap = new Map<string, string>()
  for (const { tweetId: id, articles } of articleEnvelope) {
    articlesById.set(id, articles)
    if (articles.length > 0) statusMap.set(id, articles[0].status)
  }

  try {
    upsertTweets(db, response.data, response.includes, 'bookmarks', statusMap)
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (bookmarks): ${err}\n`)
  }

  const formatted = response.data
    .map((t) => {
      const articlesBlock = formatArticlesLines(articlesById.get(t.id) ?? [])
      return `${formatTweet(t, response.includes)}${articlesBlock}`
    })
    .join('\n\n')
  const pagination = response.meta?.next_token
    ? `\n\n--- More bookmarks available. Use next_token: "${response.meta.next_token}" ---`
    : ''
  const rateLimitInfo = `\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{
      type: 'text' as const,
      text: `${response.meta?.result_count ?? response.data.length} bookmarks:\n\n${formatted}${pagination}${rateLimitInfo}`,
    }],
  }
}
