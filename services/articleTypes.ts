/**
 * Shared types for article ingestion — extracted to break the circular
 * dependency between auto-crawl.ts and articleIngestService.ts.
 */

import { z } from 'zod'
import type { XTweet } from '../types.ts'
import type { TweetRow } from '../db/types.ts'

export type ArticleStatus = 'ok' | 'missing' | 'failed'

export interface ArticleResolution {
  status: ArticleStatus
  url?: string
  article_id?: string
  reason?: string
}

/**
 * Runtime-validation schema for a single ArticleResolution entry.  Used by
 * `tweetArticlesEnvelopeSchema` and exposed for downstream contract-probe
 * consumers (orchestrator probe-4) to validate the shape of article payloads.
 */
export const articleResolutionSchema = z.object({
  status: z.enum(['ok', 'missing', 'failed']),
  url: z.string().optional(),
  article_id: z.string().optional(),
  reason: z.string().optional(),
})

/** Tweet-shape accepted by the detector — works for both XTweet API payloads
 *  and TweetRow DB rows (which carry the relevant fields as JSON strings). */
export type DetectableTweet = Pick<XTweet, 'id' | 'text' | 'note_tweet' | 'entities'> | TweetRow

/**
 * Function signature for resolving a single tweet's articles (plural).
 *
 * Post-X3: a tweet may link multiple distinct article URLs; each resolves
 * independently (success/failure/timeout per URL). The resolver therefore
 * returns an array of resolutions — one per detected URL.
 *
 * Backward compat: a tweet with zero article URLs still produces a
 * one-element array `[{ status: 'missing' }]` so `Map<tweetId, Resolution[]>`
 * always has an entry for every input tweet.
 */
export type ResolveArticleForTweet = (
  db: import('better-sqlite3').Database,
  tweet: DetectableTweet,
) => Promise<ArticleResolution[]>
