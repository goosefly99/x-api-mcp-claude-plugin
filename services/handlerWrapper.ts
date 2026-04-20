/**
 * handlerWrapper — tool-handler failure-isolation wrapper.
 *
 * Wraps a per-tool article-resolution call (`articleIngestService(...)` /
 * `resolveArticlesForTweets(...)`) with:
 *   1. A soft timeout race (default 15 000ms — matches
 *      `articleIngestService.DEFAULT_TIMEOUT_MS`).  The timer is cleared on
 *      success so we don't leak `setTimeout` handles.  The wrapped function
 *      is NOT cancelled when the timer wins — Playwright/crawler sessions
 *      can't be interrupted mid-flight; observability lives in the
 *      PLAYWRIGHT_SOFT_TIMEOUT_WIN canary emitted by articleIngestService.
 *   2. A try/catch that converts thrown errors into a `null` return and a
 *      structured stderr metric row — never propagates to the MCP response.
 *      Callers MUST handle `null` by still landing the parent tweet row.
 *   3. A structured stderr JSON metric row on every outcome (success or
 *      failure):
 *        { plugin: 'x-api', tool, articles_attempted, articles_succeeded,
 *          articles_timed_out, articles_failed, elapsed_ms }
 *
 * Metric counters:
 *  - On success, when the wrapped function returns a
 *    `TweetArticlesEnvelope`, we tally succeeded / timed_out / failed from
 *    the per-article resolutions so the counts are correct.  For any other
 *    return value, counters default to {succeeded=tweetCount, rest=0}.
 *  - On soft-timeout or throw, `articles_failed = tweetCount` (we can't see
 *    the per-article breakdown since the call didn't settle).
 */

import type { TweetArticlesEnvelope } from '../types.ts'

const DEFAULT_SOFT_TIMEOUT_MS = 15_000

export interface FailureIsolationOpts {
  /** Soft timeout in ms — defaults to 15 000 to match articleIngestService. */
  softTimeoutMs?: number
}

interface HandlerMetricRow {
  plugin: 'x-api'
  tool: string
  articles_attempted: number
  articles_succeeded: number
  articles_timed_out: number
  articles_failed: number
  elapsed_ms: number
}

function emitMetric(row: HandlerMetricRow): void {
  try {
    process.stderr.write(JSON.stringify(row) + '\n')
  } catch {
    // stderr.write should never throw in practice; swallow defensively so a
    // stringify issue never breaks the caller.
  }
}

/**
 * Duck-type check: does `value` look like a `TweetArticlesEnvelope`?
 * Used so we can tally finer-grained counters when the wrapped function
 * returns the envelope directly.
 */
function looksLikeEnvelope(value: unknown): value is TweetArticlesEnvelope {
  if (!Array.isArray(value)) return false
  return value.every(
    (e) =>
      e !== null &&
      typeof e === 'object' &&
      'tweetId' in e &&
      'articles' in e &&
      Array.isArray((e as { articles: unknown }).articles),
  )
}

function tallyEnvelope(envelope: TweetArticlesEnvelope): {
  succeeded: number
  timedOut: number
  failed: number
} {
  let succeeded = 0
  let timedOut = 0
  let failed = 0
  for (const { articles } of envelope) {
    for (const a of articles) {
      if (a.status === 'ok') succeeded++
      else if (a.status === 'failed' && a.reason === 'timeout') timedOut++
      else if (a.status === 'failed') failed++
      // `missing` is neither a success nor a failure; don't count it.
    }
  }
  return { succeeded, timedOut, failed }
}

/**
 * Wraps `fn()` in a Promise.race against a soft timeout.  Returns the
 * result on success; returns `null` on soft-timeout or throw.  Always emits
 * a structured metric row to stderr.
 *
 * The parent tweet upsert MUST run regardless of what this function returns
 * — callers should treat `null` identically to an empty envelope.
 */
export async function withFailureIsolation<T>(
  name: string,
  tweetCount: number,
  fn: () => Promise<T>,
  opts?: FailureIsolationOpts,
): Promise<T | null> {
  const softTimeoutMs = opts?.softTimeoutMs ?? DEFAULT_SOFT_TIMEOUT_MS
  const start = Date.now()

  // Timeout race.  We tag the sentinel so we can tell the two branches apart
  // without a truthy/falsy check on user-supplied values (T could legitimately
  // be null/undefined for non-envelope callers).
  const TIMEOUT_SENTINEL = Symbol('timeout')

  let timeoutHandle: NodeJS.Timeout | null = null
  const timeoutPromise = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(TIMEOUT_SENTINEL), softTimeoutMs)
  })

  try {
    const outcome = await Promise.race([fn(), timeoutPromise])

    if (outcome === TIMEOUT_SENTINEL) {
      emitMetric({
        plugin: 'x-api',
        tool: name,
        articles_attempted: tweetCount,
        articles_succeeded: 0,
        articles_timed_out: tweetCount,
        articles_failed: 0,
        elapsed_ms: Date.now() - start,
      })
      process.stderr.write(
        `x-api: handlerWrapper soft-timeout (${name}, ${softTimeoutMs}ms)\n`,
      )
      return null
    }

    // fn() settled first — clear the timer so we don't leak a pending handle.
    if (timeoutHandle) clearTimeout(timeoutHandle)

    // If outcome looks like an envelope, tally finer-grained counters.
    if (looksLikeEnvelope(outcome)) {
      const { succeeded, timedOut, failed } = tallyEnvelope(outcome)
      emitMetric({
        plugin: 'x-api',
        tool: name,
        articles_attempted: tweetCount,
        articles_succeeded: succeeded,
        articles_timed_out: timedOut,
        articles_failed: failed,
        elapsed_ms: Date.now() - start,
      })
    } else {
      // Non-envelope return (unlikely for tweet-returning tools but safe).
      emitMetric({
        plugin: 'x-api',
        tool: name,
        articles_attempted: tweetCount,
        articles_succeeded: tweetCount,
        articles_timed_out: 0,
        articles_failed: 0,
        elapsed_ms: Date.now() - start,
      })
    }

    return outcome as T
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle)
    const reason = err instanceof Error ? err.message : String(err)
    emitMetric({
      plugin: 'x-api',
      tool: name,
      articles_attempted: tweetCount,
      articles_succeeded: 0,
      articles_timed_out: 0,
      articles_failed: tweetCount,
      elapsed_ms: Date.now() - start,
    })
    process.stderr.write(`x-api: handlerWrapper error (${name}): ${reason}\n`)
    return null
  }
}
