import { xApiRequest, formatTweet, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XTweet } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertTweets } from '../db/repos/tweets.ts'

export async function handleGetTweet(args: Record<string, unknown>) {
  const tweetId = args.tweet_id as string
  if (!tweetId) throw new Error('tweet_id is required')

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

  try {
    upsertTweets(getDb(), [response.data], response.includes, 'get_tweet')
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (get_tweet): ${err}\n`)
  }

  const formatted = formatTweet(response.data, response.includes)
  const rateLimitInfo = `\n\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{ type: 'text' as const, text: `${formatted}${rateLimitInfo}` }],
  }
}

export async function handleGetUserTweets(args: Record<string, unknown>) {
  const userId = args.user_id as string
  if (!userId) throw new Error('user_id is required')

  const maxResults = Math.max(5, Math.min(100, Number(args.max_results) || 10))
  const nextToken = args.next_token as string | undefined

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

  try {
    upsertTweets(getDb(), response.data, response.includes, 'user_tweets')
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (user_tweets): ${err}\n`)
  }

  const formatted = response.data.map((t) => formatTweet(t, response.includes)).join('\n\n')
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
