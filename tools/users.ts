import { xApiRequest, formatUser, formatTweet, USER_FIELDS, TWEET_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XUser, XTweet } from '../types.ts'

const USER_FIELDS_EXTENDED = USER_FIELDS + ',url,location,pinned_tweet_id'

export async function handleGetUser(args: Record<string, unknown>) {
  let username = args.username as string
  if (!username) throw new Error('username is required')

  // Strip leading @ if present
  username = username.replace(/^@/, '')

  const { response, rateLimit } = await xApiRequest<XUser>(
    `users/by/username/${encodeURIComponent(username)}`,
    { 'user.fields': USER_FIELDS_EXTENDED },
    'app'
  )

  if (!response.data) {
    return {
      content: [{ type: 'text' as const, text: `User @${username} not found.` }],
    }
  }

  let formatted = formatUser(response.data)

  // Fetch pinned tweet if present
  if (response.data.pinned_tweet_id) {
    try {
      const { response: pinnedResponse } = await xApiRequest<XTweet>(
        `tweets/${encodeURIComponent(response.data.pinned_tweet_id)}`,
        {
          'tweet.fields': TWEET_FIELDS,
          'user.fields': USER_FIELDS,
          expansions: EXPANSIONS,
          'media.fields': MEDIA_FIELDS,
        },
        'app'
      )
      if (pinnedResponse.data) {
        formatted += `\n\nPinned Tweet:\n${formatTweet(pinnedResponse.data, pinnedResponse.includes)}`
      }
    } catch {
      formatted += `\n\nPinned Tweet: ${response.data.pinned_tweet_id} (could not fetch)`
    }
  }

  const rateLimitInfo = `\n\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{ type: 'text' as const, text: `${formatted}${rateLimitInfo}` }],
  }
}
