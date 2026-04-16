/**
 * articleIngestService — concurrent article ingestion with a semaphore cap.
 *
 * Wraps the existing detect → exists-in-db → crawl → upsert logic and runs
 * it in parallel up to `concurrency` (default 4) simultaneous resolver calls.
 *
 * The `resolver` function is injected by the caller (dependency injection) so
 * this module does not need to import from auto-crawl.ts, eliminating the
 * circular ESM dependency.
 *
 * Semaphore pattern: a counter + a queue of resolve callbacks.
 * acquire() decrements permits; when 0, it waits. release() increments and
 * unblocks the next waiter. This guarantees at most N tasks run concurrently.
 */

import type Database from 'better-sqlite3'
import type {
  ArticleResolution,
  DetectableTweet,
  ResolveArticleForTweet,
} from './articleTypes.ts'

export type { ArticleResolution, DetectableTweet, ResolveArticleForTweet }

const DEFAULT_CONCURRENCY = 4

export interface ArticleIngestOptions {
  /** Max simultaneous resolver calls. Defaults to 4. */
  concurrency?: number
  /** Function that resolves a single tweet's article. Required. */
  resolver: ResolveArticleForTweet
}

export interface ArticleIngestService {
  ingestForTweets(
    db: Database.Database,
    tweets: DetectableTweet[],
  ): Promise<Map<string, ArticleResolution>>
}

// ── Semaphore ──────────────────────────────────────────────────────────────

class Semaphore {
  private permits: number
  private waiters: Array<() => void> = []

  constructor(n: number) {
    this.permits = n
  }

  acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  release(): void {
    const next = this.waiters.shift()
    if (next) {
      // Give the permit directly to the next waiter (permits stays at 0).
      next()
    } else {
      this.permits++
    }
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Factory that returns an ArticleIngestService configured with the given
 * concurrency cap and resolver function.
 */
export function articleIngestService(opts: ArticleIngestOptions): ArticleIngestService {
  const cap = opts.concurrency ?? DEFAULT_CONCURRENCY
  const { resolver } = opts

  return {
    async ingestForTweets(
      db: Database.Database,
      tweets: DetectableTweet[],
    ): Promise<Map<string, ArticleResolution>> {
      const out = new Map<string, ArticleResolution>()
      const sem = new Semaphore(cap)

      const tasks = tweets.map(async (tweet) => {
        await sem.acquire()
        try {
          const res = await resolver(db, tweet)
          out.set(tweet.id, res)
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err)
          out.set(tweet.id, { status: 'failed', reason })
        } finally {
          sem.release()
        }
      })

      await Promise.all(tasks)
      return out
    },
  }
}
