/**
 * Shared types for article ingestion — extracted to break the circular
 * dependency between auto-crawl.ts and articleIngestService.ts.
 */

import type { XTweet } from '../types.ts'
import type { TweetRow } from '../db/types.ts'

export type ArticleStatus = 'ok' | 'missing' | 'failed'

export interface ArticleResolution {
  status: ArticleStatus
  url?: string
  article_id?: string
  reason?: string
}

/** Tweet-shape accepted by the detector — works for both XTweet API payloads
 *  and TweetRow DB rows (which carry the relevant fields as JSON strings). */
export type DetectableTweet = Pick<XTweet, 'id' | 'text' | 'note_tweet' | 'entities'> | TweetRow

/**
 * Function signature for resolving a single tweet's article.
 * Injected into articleIngestService to avoid a circular import.
 */
export type ResolveArticleForTweet = (
  db: import('better-sqlite3').Database,
  tweet: DetectableTweet,
) => Promise<ArticleResolution>
