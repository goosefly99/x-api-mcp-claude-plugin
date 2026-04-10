import { xApiRequest, formatTweet, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XTweet, XUser } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertTweets } from '../db/repos/tweets.ts'

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

  try {
    upsertTweets(getDb(), response.data, response.includes, 'bookmarks')
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (bookmarks): ${err}\n`)
  }

  const formatted = response.data.map((t) => formatTweet(t, response.includes)).join('\n\n')
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
