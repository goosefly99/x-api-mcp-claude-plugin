import { xApiRequest, formatTweet, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XTweet } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertTweets } from '../db/repos/tweets.ts'
import { resolveArticlesForTweets, formatArticleLine, type ArticleResolution } from '../services/auto-crawl.ts'

export async function handleGetTweet(args: Record<string, unknown>) {
  const tweetId = args.tweet_id as string
  if (!tweetId) throw new Error('tweet_id is required')

  const autoCrawl = args.auto_crawl_articles !== false

  const { response, rateLimit } = await xApiRequest<XTweet>(
    `tweets/${encodeURIComponent(tweetId)}`,
    {
      'tweet.fields': TWEET_FIELDS,
      'user.fields': USER_FIELDS,
      expansions: EXPANSIONS,
      'media.fields': MEDIA_FIELDS,
    },
    'app'
  )

  if (!response.data) {
    return {
      content: [{ type: 'text' as const, text: `Tweet ${tweetId} not found.` }],
    }
  }

  // Resolve articles BEFORE persisting so article_crawl_status lands in
  // the same transaction as the tweet row.
  const db = getDb()
  // TODO(X4): Surface all elements of articles[] in the tool response.
  // For now we keep the legacy single-article display by reading articles[0].
  let articleMap = new Map<string, ArticleResolution[]>()
  if (autoCrawl) {
    try {
      articleMap = await resolveArticlesForTweets(db, [response.data])
    } catch (err) {
      process.stderr.write(`x-api: auto-crawl failed (get_tweet): ${err}\n`)
    }
  }

  const statusMap = new Map<string, string>()
  for (const [id, res] of articleMap) {
    // TODO(X4): tweets.article_crawl_status currently reflects only the first
    // article's status. Revisit when the envelope fans articles[] to the UI.
    if (res.length > 0) statusMap.set(id, res[0].status)
  }

  try {
    upsertTweets(db, [response.data], response.includes, 'get_tweet', statusMap)
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (get_tweet): ${err}\n`)
  }

  const formatted = formatTweet(response.data, response.includes)
  const firstResolution = articleMap.get(response.data.id)?.[0]
  const articleLine = firstResolution
    ? `\n${formatArticleLine(firstResolution)}`
    : ''
  const rateLimitInfo = `\n\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{ type: 'text' as const, text: `${formatted}${articleLine}${rateLimitInfo}` }],
  }
}

export async function handleGetUserTweets(args: Record<string, unknown>) {
  const userId = args.user_id as string
  if (!userId) throw new Error('user_id is required')

  const maxResults = Math.max(5, Math.min(100, Number(args.max_results) || 10))
  const nextToken = args.next_token as string | undefined
  const autoCrawl = args.auto_crawl_articles !== false

  // Note: user tweets endpoint uses pagination_token, not next_token
  const params: Record<string, string | undefined> = {
    max_results: String(maxResults),
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
    pagination_token: nextToken,
  }

  const { response, rateLimit } = await xApiRequest<XTweet[]>(
    `users/${encodeURIComponent(userId)}/tweets`,
    params,
    'app'
  )

  if (!response.data || response.data.length === 0) {
    return {
      content: [{ type: 'text' as const, text: `No tweets found for user ${userId}.` }],
    }
  }

  const db = getDb()
  // TODO(X4): Surface all elements of articles[] in the tool response.
  let articleMap = new Map<string, ArticleResolution[]>()
  if (autoCrawl) {
    try {
      articleMap = await resolveArticlesForTweets(db, response.data)
    } catch (err) {
      process.stderr.write(`x-api: auto-crawl failed (user_tweets): ${err}\n`)
    }
  }

  const statusMap = new Map<string, string>()
  for (const [id, res] of articleMap) {
    if (res.length > 0) statusMap.set(id, res[0].status)
  }

  try {
    upsertTweets(db, response.data, response.includes, 'user_tweets', statusMap)
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (user_tweets): ${err}\n`)
  }

  const formatted = response.data
    .map((t) => {
      const first = articleMap.get(t.id)?.[0]
      const line = first ? `\n${formatArticleLine(first)}` : ''
      return `${formatTweet(t, response.includes)}${line}`
    })
    .join('\n\n')
  const pagination = response.meta?.next_token
    ? `\n\n--- More tweets available. Use next_token: "${response.meta.next_token}" ---`
    : ''
  const rateLimitInfo = `\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{
      type: 'text' as const,
      text: `${response.meta?.result_count ?? response.data.length} tweets:\n\n${formatted}${pagination}${rateLimitInfo}`,
    }],
  }
}
