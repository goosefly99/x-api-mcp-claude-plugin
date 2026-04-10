import { getBearerToken, getUserAccessToken, refreshAccessToken, loadTokens } from './auth.ts'
import type { XTweet, XUser, XMedia, XIncludes, XApiResponse, XRateLimitInfo } from './types.ts'

const BASE_URL = 'https://api.x.com/2'

export const TWEET_FIELDS = 'created_at,author_id,public_metrics,entities,note_tweet,conversation_id,referenced_tweets,attachments'
export const USER_FIELDS = 'description,public_metrics,profile_image_url,verified,created_at'
export const EXPANSIONS = 'author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys'
export const MEDIA_FIELDS = 'type,url,preview_image_url,alt_text,duration_ms,variants'

export interface ApiResult<T> {
  response: XApiResponse<T>
  rateLimit: XRateLimitInfo
}

/** Make an authenticated request to the X API v2 */
export async function xApiRequest<T>(
  endpoint: string,
  params: Record<string, string | undefined>,
  authMode: 'app' | 'user'
): Promise<ApiResult<T>> {
  const token = authMode === 'app'
    ? await getBearerToken()
    : await getUserAccessToken()

  if (!token) {
    throw new Error('Not authorized. Run x_authorize first to connect your X account.')
  }

  const url = new URL(`${BASE_URL}/${endpoint}`)
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) url.searchParams.set(k, v)
  }

  let res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })

  // Auto-refresh on 401 for user context
  if (res.status === 401 && authMode === 'user') {
    const tokens = loadTokens()
    if (tokens?.refresh_token) {
      try {
        const refreshed = await refreshAccessToken(tokens.refresh_token)
        res = await fetch(url.toString(), {
          headers: { Authorization: `Bearer ${refreshed.access_token}` },
        })
      } catch {
        throw new Error('Session expired. Run x_authorize to re-authenticate.')
      }
    } else {
      throw new Error('Session expired. Run x_authorize to re-authenticate.')
    }
  }

  const rateLimit: XRateLimitInfo = {
    limit: parseInt(res.headers.get('x-rate-limit-limit') ?? '0', 10),
    remaining: parseInt(res.headers.get('x-rate-limit-remaining') ?? '0', 10),
    reset: parseInt(res.headers.get('x-rate-limit-reset') ?? '0', 10),
  }

  if (res.status === 429) {
    const resetDate = new Date(rateLimit.reset * 1000)
    throw new Error(
      `Rate limited. Try again after ${resetDate.toLocaleTimeString()}`
    )
  }

  if (!res.ok) {
    const body = await res.text()
    let detail = body
    try {
      const parsed = JSON.parse(body)
      detail = parsed.errors?.[0]?.detail ?? parsed.detail ?? body
    } catch { /* use raw body */ }
    throw new Error(`X API error (${res.status}): ${detail}`)
  }

  const response = (await res.json()) as XApiResponse<T>
  return { response, rateLimit }
}

/** Get the best URL for a media object */
function getMediaUrl(media: XMedia): string {
  if (media.type === 'photo') return media.url ?? media.preview_image_url ?? ''
  // For video/animated_gif, pick the highest bitrate variant
  if (media.variants?.length) {
    const best = media.variants
      .filter((v) => v.content_type === 'video/mp4')
      .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0]
    if (best) return best.url
  }
  return media.preview_image_url ?? ''
}

/** Format a tweet into a readable text block */
export function formatTweet(tweet: XTweet, includes?: XIncludes): string {
  const author = includes?.users?.find((u) => u.id === tweet.author_id)
  const authorStr = author ? `@${author.username} (${author.name})` : tweet.author_id ?? 'unknown'
  const date = tweet.created_at ? new Date(tweet.created_at).toLocaleString() : ''
  const metrics = tweet.public_metrics
    ? `  Likes: ${tweet.public_metrics.like_count} | RT: ${tweet.public_metrics.retweet_count} | Replies: ${tweet.public_metrics.reply_count}`
    : ''

  // Use note_tweet (article) content if available, otherwise regular text
  const isArticle = !!tweet.note_tweet?.text
  const content = tweet.note_tweet?.text ?? tweet.text
  const contentUrls = tweet.note_tweet?.entities?.urls ?? tweet.entities?.urls
  const urls = contentUrls
    ?.map((u) => `  ${u.display_url} → ${u.expanded_url}`)
    ?.join('\n') ?? ''

  // Referenced tweets (quotes, replies)
  const refParts: string[] = []
  if (tweet.referenced_tweets?.length && includes?.tweets) {
    for (const ref of tweet.referenced_tweets) {
      const refTweet = includes.tweets.find((t) => t.id === ref.id)
      if (!refTweet) continue
      const refAuthor = includes.users?.find((u) => u.id === refTweet.author_id)
      const refAuthorStr = refAuthor ? `@${refAuthor.username}` : refTweet.author_id ?? 'unknown'
      const refText = refTweet.note_tweet?.text ?? refTweet.text
      const label = ref.type === 'quoted' ? 'Quoted Tweet'
        : ref.type === 'replied_to' ? 'Replying To'
        : 'Retweeted'
      refParts.push(`  ${label} (${ref.id}) by ${refAuthorStr}:\n    ${refText.replace(/\n/g, '\n    ')}`)
    }
  }

  // Media metadata
  const mediaParts: string[] = []
  if (tweet.attachments?.media_keys?.length && includes?.media) {
    for (const key of tweet.attachments.media_keys) {
      const media = includes.media.find((m) => m.media_key === key)
      if (!media) continue
      const mediaUrl = getMediaUrl(media)
      mediaParts.push(`  [${media.type}] ${mediaUrl}`)
    }
  }

  const parts = [
    `--- Tweet ${tweet.id} ---`,
    `Author: ${authorStr}`,
    author?.description ? `Bio: ${author.description}` : '',
    date ? `Date: ${date}` : '',
    tweet.conversation_id ? `Thread: ${tweet.conversation_id}` : '',
    isArticle ? '[Article]\n' : '',
    content,
    metrics ? `\n${metrics}` : '',
    refParts.length ? `\n${refParts.join('\n')}` : '',
    mediaParts.length ? `\nMedia:\n${mediaParts.join('\n')}` : '',
    urls ? `\nLinks:\n${urls}` : '',
  ]

  return parts.filter(Boolean).join('\n')
}

/** Format a user profile into a readable text block */
export function formatUser(user: XUser): string {
  const m = user.public_metrics
  const metrics = m
    ? `Followers: ${m.followers_count} | Following: ${m.following_count} | Tweets: ${m.tweet_count}`
    : ''

  const parts = [
    `--- @${user.username} ---`,
    `Name: ${user.name}`,
    user.description ? `Bio: ${user.description}` : '',
    user.location ? `Location: ${user.location}` : '',
    user.url ? `URL: ${user.url}` : '',
    metrics,
    user.created_at ? `Joined: ${new Date(user.created_at).toLocaleDateString()}` : '',
  ]

  return parts.filter(Boolean).join('\n')
}
