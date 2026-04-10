import { xApiRequest, formatTweet, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XTweet } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertTweets } from '../db/repos/tweets.ts'

export async function handleSearchTweets(args: Record<string, unknown>) {
  const query = args.query as string
  if (!query) throw new Error('query is required')

  const maxResults = Math.max(10, Math.min(100, Number(args.max_results) || 10))
  const nextToken = args.next_token as string | undefined

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

  try {
    upsertTweets(getDb(), response.data, response.includes, 'search')
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (search): ${err}\n`)
  }

  const formatted = response.data.map((t) => formatTweet(t, response.includes)).join('\n\n')
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
