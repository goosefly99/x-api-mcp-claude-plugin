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

import os from 'node:os'
import type Database from 'better-sqlite3'
import type {
  ArticleResolution,
  DetectableTweet,
  ResolveArticleForTweet,
} from './articleTypes.ts'
import type { TweetArticlesEnvelope } from '../types.ts'
import { getBrowserContextId } from '../crawler.ts'

export type { ArticleResolution, DetectableTweet, ResolveArticleForTweet }

const DEFAULT_CONCURRENCY = 4
export const DEFAULT_TIMEOUT_MS = 15_000

/**
 * Sentinel object used to distinguish the timeout branch from the resolver
 * branch in the per-tweet Promise.race.  Plain object equality is enough —
 * a Symbol would also work but collides awkwardly with the ArticleResolution[]
 * union TypeScript infers for the race result.
 */
const TIMEOUT_TAG = { __timeout: true } as const
type TimeoutSignal = typeof TIMEOUT_TAG

function isTimeoutSignal(x: unknown): x is TimeoutSignal {
  return x === TIMEOUT_TAG
}

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
  ): Promise<TweetArticlesEnvelope>
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
 * Returns a Promise that resolves (never rejects) with the TIMEOUT_TAG
 * sentinel after `ms` milliseconds.  The caller distinguishes the two
 * Promise.race arms by checking identity against TIMEOUT_TAG — when the
 * timer wins, the caller emits the PLAYWRIGHT_SOFT_TIMEOUT_WIN canary
 * before synthesising a `{ status: 'failed', reason: 'timeout' }`
 * resolution for the tweet.
 *
 * Also returns the setTimeout handle so the caller can clearTimeout() on
 * the resolver-wins path, avoiding dangling timers.
 */
function timeoutResolution(
  ms: number,
): { promise: Promise<TimeoutSignal>; handle: NodeJS.Timeout } {
  let handle!: NodeJS.Timeout
  const promise = new Promise<TimeoutSignal>((resolve) => {
    handle = setTimeout(() => resolve(TIMEOUT_TAG), ms)
  })
  return { promise, handle }
}

/**
 * Crude proxy for "how many network-capable interfaces are live on this
 * host".  Used as an `open_sockets_count` stand-in in the
 * PLAYWRIGHT_SOFT_TIMEOUT_WIN canary — enough to detect accumulation over
 * time without parsing netstat.
 *
 * NOTE: crude proxy — accurate open-socket count requires netstat parsing
 * (deferred to v0.5.0).
 */
function openSocketsCountProxy(): number {
  try {
    return Object.keys(os.networkInterfaces()).length
  } catch {
    return 0
  }
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
    ): Promise<TweetArticlesEnvelope> {
      // Build the envelope array directly (no intermediate Map allocation).
      // Slot order matches `tweets` input order; each slot is filled once
      // the corresponding task settles.
      const out: TweetArticlesEnvelope = tweets.map((tweet) => ({
        tweetId: tweet.id,
        articles: [] as ArticleResolution[],
      }))
      const sem = new Semaphore(cap)

      const tasks = tweets.map(async (tweet, idx) => {
        await sem.acquire()
        const start = Date.now()
        const { promise: timeoutPromise, handle: timeoutHandle } =
          timeoutResolution(timeoutMs)
        try {
          // Race the resolver against a soft timeout.  The timeout promise
          // resolves (not rejects) to TIMEOUT_TAG so Promise.race always
          // settles cleanly.  The resolver is NOT cancelled — it may
          // continue running in the background (e.g. a Playwright session
          // that can't be interrupted mid-flight); we emit the
          // PLAYWRIGHT_SOFT_TIMEOUT_WIN canary as the observability bridge.
          //
          // Post-X3: resolver returns an array (one entry per article URL
          // on the tweet).  The timeout arm returns a one-element failure
          // array so downstream consumers can treat both branches uniformly.
          const outcome = await Promise.race([
            resolver(db, tweet),
            timeoutPromise,
          ])

          if (isTimeoutSignal(outcome)) {
            // Emit the resource-leak canary: the resolver lost the race and
            // is likely still holding a Playwright page/socket we cannot
            // cancel.  Operators correlate `browser_context_id` over time
            // to detect context accumulation.
            const elapsed = Date.now() - start
            try {
              process.stderr.write(
                JSON.stringify({
                  plugin: 'x-api',
                  error_code: 'PLAYWRIGHT_SOFT_TIMEOUT_WIN',
                  open_sockets_count: openSocketsCountProxy(),
                  browser_context_id: getBrowserContextId(),
                  tweet_id: tweet.id,
                  elapsed_ms: elapsed,
                }) + '\n',
              )
            } catch {
              // Never let a serialization hiccup break the main flow.
            }
            out[idx].articles = [{ status: 'failed', reason: 'timeout' }]
          } else {
            // Resolver wins — clear the pending timer so we don't leak a
            // handle for the remaining `timeoutMs - elapsed` milliseconds.
            clearTimeout(timeoutHandle)
            out[idx].articles = outcome
          }
        } catch (err: unknown) {
          clearTimeout(timeoutHandle)
          const reason = err instanceof Error ? err.message : String(err)
          out[idx].articles = [{ status: 'failed', reason }]
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
