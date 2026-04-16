/** Long-form post / X Article content */
export interface XNoteTweet {
  text: string
  entities?: {
    urls?: Array<{
      start: number
      end: number
      url: string
      expanded_url: string
      display_url: string
      title?: string
      description?: string
    }>
    mentions?: Array<{
      start: number
      end: number
      username: string
    }>
    hashtags?: Array<{
      start: number
      end: number
      tag: string
    }>
  }
}

/** Reference to another tweet (quote, reply, retweet) */
export interface XReferencedTweet {
  type: 'quoted' | 'replied_to' | 'retweeted'
  id: string
}

/** Media attachment metadata */
export interface XMedia {
  media_key: string
  type: 'photo' | 'video' | 'animated_gif'
  url?: string
  preview_image_url?: string
  alt_text?: string
  duration_ms?: number
  variants?: Array<{
    bit_rate?: number
    content_type: string
    url: string
  }>
}

/** Core tweet object from X API v2 */
export interface XTweet {
  id: string
  text: string
  created_at?: string
  author_id?: string
  public_metrics?: {
    retweet_count: number
    reply_count: number
    like_count: number
    quote_count: number
    impression_count?: number
    bookmark_count?: number
  }
  entities?: {
    urls?: Array<{
      start: number
      end: number
      url: string
      expanded_url: string
      display_url: string
      title?: string
      description?: string
    }>
    mentions?: Array<{
      start: number
      end: number
      username: string
      id: string
    }>
    hashtags?: Array<{
      start: number
      end: number
      tag: string
    }>
  }
  note_tweet?: XNoteTweet
  conversation_id?: string
  referenced_tweets?: XReferencedTweet[]
  attachments?: {
    media_keys?: string[]
  }
}

/** User object from X API v2 */
export interface XUser {
  id: string
  name: string
  username: string
  description?: string
  public_metrics?: {
    followers_count: number
    following_count: number
    tweet_count: number
    listed_count: number
  }
  profile_image_url?: string
  verified?: boolean
  created_at?: string
  url?: string
  location?: string
  pinned_tweet_id?: string
}

/** Expanded objects included in API responses */
export interface XIncludes {
  users?: XUser[]
  tweets?: XTweet[]
  media?: XMedia[]
}

/** Pagination metadata */
export interface XMeta {
  next_token?: string
  result_count?: number
  newest_id?: string
  oldest_id?: string
}

/** X API v2 error object */
export interface XApiError {
  title: string
  detail: string
  type: string
  status?: number
}

/** Generic X API v2 response wrapper */
export interface XApiResponse<T> {
  data?: T
  includes?: XIncludes
  meta?: XMeta
  errors?: XApiError[]
}

/** Stored OAuth 2.0 tokens */
export interface XTokens {
  access_token: string
  refresh_token?: string
  expires_at?: number
  token_type: string
  scope?: string
}

/** Rate limit info extracted from response headers */
export interface XRateLimitInfo {
  limit: number
  remaining: number
  reset: number
}

// ── Article envelope (X3 refactor: singular → plural) ─────────────────────────

/**
 * A single resolved article linked to a tweet.  Re-exported here so tool-layer
 * consumers can import `Article` without reaching into `services/articleTypes`.
 * Post-X3 a tweet carries `articles: Article[]` (plural) — a tweet with two
 * qualifying expanded_urls produces two Article entries.
 */
export type { ArticleResolution as Article } from './services/articleTypes.ts'

/**
 * Per-tweet envelope shape produced by `resolveArticlesForTweets`.
 *   { tweetId: 'abc', articles: [Article, Article] }
 *
 * NOTE: This is the logical shape; the service currently returns
 * `Map<tweetId, Article[]>` rather than an object-shaped envelope.  The
 * interface below documents the contract for future consumers (e.g. X4
 * tool-surface rework) without forcing a map→object migration in this PR.
 */
export interface TweetArticlesEnvelope {
  tweetId: string
  articles: import('./services/articleTypes.ts').ArticleResolution[]
}
