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
const DEFAULT_TIMEOUT_MS = 15_000

export interface ArticleIngestOptions {
  /** Max simultaneous resolver calls. Defaults to 4. */
  concurrency?: number
  /** Function that resolves a single tweet's article. Required. */
  resolver: ResolveArticleForTweet
  /**
   * Soft timeout in milliseconds for each resolver call. Defaults to 15 000.
   * If the resolver has not returned within this window, the article is
   * recorded as `{ status: 'failed', reason: 'timeout' }` and the service
   * moves on.  The resolver itself is NOT cancelled — Playwright (or whatever
   * the resolver uses) may continue running in the background.
   */
  timeoutMs?: number
}

export interface ArticleIngestService {
  ingestForTweets(
    db: Database.Database,
    tweets: DetectableTweet[],
  ): Promise<Map<string, ArticleResolution[]>>
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

// ── Timeout helper ───────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves (never rejects) with a timed-out
 * ArticleResolution[] sentinel after `ms` milliseconds. The plural return
 * mirrors ResolveArticleForTweet so Promise.race settles to a single shape.
 */
function timeoutResolution(ms: number): Promise<ArticleResolution[]> {
  return new Promise<ArticleResolution[]>((resolve) => {
    setTimeout(() => resolve([{ status: 'failed', reason: 'timeout' }]), ms)
  })
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Factory that returns an ArticleIngestService configured with the given
 * concurrency cap, resolver function, and per-article timeout.
 */
export function articleIngestService(opts: ArticleIngestOptions): ArticleIngestService {
  const cap = opts.concurrency ?? DEFAULT_CONCURRENCY
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const { resolver } = opts

  return {
    async ingestForTweets(
      db: Database.Database,
      tweets: DetectableTweet[],
    ): Promise<Map<string, ArticleResolution[]>> {
      const out = new Map<string, ArticleResolution[]>()
      const sem = new Semaphore(cap)

      const tasks = tweets.map(async (tweet) => {
        await sem.acquire()
        try {
          // Race the resolver against a soft timeout.  The timeout promise
          // resolves (not rejects) so Promise.race always settles to a valid
          // ArticleResolution[].  The resolver is NOT cancelled — it may
          // continue running in the background (e.g. a Playwright session
          // that can't be interrupted mid-flight).
          //
          // Post-X3: resolver returns an array (one entry per article URL
          // on the tweet).  The timeout arm returns a one-element failure
          // array so downstream consumers can treat both branches uniformly.
          const res = await Promise.race([
            resolver(db, tweet),
            timeoutResolution(timeoutMs),
          ])
          out.set(tweet.id, res)
        } catch (err: unknown) {
          const reason = err instanceof Error ? err.message : String(err)
          out.set(tweet.id, [{ status: 'failed', reason }])
        } finally {
          // Semaphore must release regardless of how the race settled.
          sem.release()
        }
      })

      await Promise.all(tasks)
      return out
    },
  }
}
