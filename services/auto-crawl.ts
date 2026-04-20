/**
 * Auto-crawl service.
 *
 * When a tweet returned by the X API links to an X Article (or a qualifying
 * external article URL), we automatically invoke the crawler and store the
 * article body in `articles`, keyed to the tweet. This module orchestrates
 * detect → exists → crawl and returns a per-tweet status record that the
 * tool handlers use for (a) writing `tweets.article_crawl_status` in the
 * same transaction and (b) rendering a one-line summary in the tool output.
 *
 * A crawl failure must never fail the parent tweet insert — callers record
 * `status: 'failed'` for the tweet and continue.
 */

import type Database from 'better-sqlite3'
import type { TweetRow } from '../db/types.ts'
import type { TweetArticlesEnvelope, XTweet } from '../types.ts'
import { crawlArticle } from '../crawler.ts'
import { upsertArticle, insertTweetArticle } from '../db/repos/articles.ts'
import { articleIngestService } from './articleIngestService.ts'
import type { ArticleResolution, DetectableTweet } from './articleTypes.ts'

// Re-export shared types so existing importers of auto-crawl.ts are unaffected.
export type { ArticleResolution, DetectableTweet }
export type ArticleStatus = 'ok' | 'missing' | 'failed'

// ── URL detection ────────────────────────────────────────────────

const X_ARTICLE_RE = /https?:\/\/(?:x|twitter)\.com\/[^\s]+\/status\/\d+\/article\/\d+/i
const X_BARE_ARTICLE_RE = /https?:\/\/(?:x|twitter)\.com\/i\/article\/\d+/i

// Hosts that almost always point at article-style long-form content.
// The intent is "a qualifying external article URL"; we keep this list
// deliberately narrow to avoid auto-crawling arbitrary short-links.
const EXTERNAL_ARTICLE_HOSTS = [
  'substack.com',
  'medium.com',
  'nytimes.com',
  'theatlantic.com',
  'newyorker.com',
  'washingtonpost.com',
  'bloomberg.com',
  'ft.com',
  'wsj.com',
  'arxiv.org',
  'ieee.org',
  'nature.com',
  'science.org',
]

interface UrlEntity {
  expanded_url?: string
  url?: string
  display_url?: string
}

function collectCandidateUrls(tweet: DetectableTweet): string[] {
  const out: string[] = []

  // 1. API-shaped entities (note_tweet + top-level)
  const apiTweet = tweet as XTweet
  const noteUrls = apiTweet.note_tweet?.entities?.urls
  if (Array.isArray(noteUrls)) {
    for (const u of noteUrls as UrlEntity[]) {
      if (u.expanded_url) out.push(u.expanded_url)
      else if (u.url) out.push(u.url)
    }
  }
  const topUrls = apiTweet.entities?.urls
  if (Array.isArray(topUrls)) {
    for (const u of topUrls as UrlEntity[]) {
      if (u.expanded_url) out.push(u.expanded_url)
      else if (u.url) out.push(u.url)
    }
  }

  // 2. DB-row-shaped entities (entities_json)
  const row = tweet as TweetRow
  if (typeof row.entities_json === 'string' && row.entities_json.length > 0) {
    try {
      const parsed = JSON.parse(row.entities_json) as { urls?: UrlEntity[] }
      if (Array.isArray(parsed?.urls)) {
        for (const u of parsed.urls) {
          if (u.expanded_url) out.push(u.expanded_url)
          else if (u.url) out.push(u.url)
        }
      }
    } catch {
      // malformed JSON — ignore
    }
  }

  // 3. Fallback: scan raw text for bare URLs
  const text = (apiTweet.text ?? row.text ?? '')
  const noteText = apiTweet.note_tweet?.text ?? row.note_tweet_text ?? ''
  for (const body of [text, noteText]) {
    if (!body) continue
    const matches = body.match(/https?:\/\/\S+/gi)
    if (matches) out.push(...matches)
  }

  return out
}

function isXArticleUrl(url: string): boolean {
  return X_ARTICLE_RE.test(url) || X_BARE_ARTICLE_RE.test(url)
}

function isQualifyingExternalArticleUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase()
    return EXTERNAL_ARTICLE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

/**
 * Returns ALL URLs in the tweet that look like article URLs — X-native
 * (`x.com/:user/status/:id/article/:num` or legacy `twitter.com`) or
 * qualifying external article URLs (substack, medium, major publishers).
 *
 * Order: X-native URLs first (preferred), then externals, preserving input
 * order within each group.  Duplicate URLs are collapsed.  Returns an
 * empty array when nothing matches.
 *
 * Post-X3: plural. A tweet can link multiple articles (e.g. a tweet that
 * includes both a substack.com and a medium.com link); each URL resolves
 * independently downstream.
 */
export function detectArticleUrls(tweet: DetectableTweet): string[] {
  const urls = collectCandidateUrls(tweet)
  const seen = new Set<string>()
  const xNative: string[] = []
  const externals: string[] = []
  for (const u of urls) {
    if (seen.has(u)) continue
    if (isXArticleUrl(u)) {
      seen.add(u)
      xNative.push(u)
    } else if (isQualifyingExternalArticleUrl(u)) {
      seen.add(u)
      externals.push(u)
    }
  }
  return [...xNative, ...externals]
}

/**
 * @deprecated Use `detectArticleUrls` (plural). Returns only the first match
 * for callers that have not yet migrated to the one-to-many contract.
 * Scheduled for removal once all callers are updated.
 */
export function detectArticleUrl(tweet: DetectableTweet): string | null {
  const all = detectArticleUrls(tweet)
  return all.length > 0 ? all[0] : null
}

// ── DB helpers ────────────────────────────────────────────────────

/** Checks the articles table for a row matching the given URL. */
export function articleExists(db: Database.Database, url: string): boolean {
  const row = db
    .prepare('SELECT 1 AS present FROM articles WHERE url = ? LIMIT 1')
    .get(url) as { present: number } | undefined
  return !!row
}

function getArticleIdByUrl(db: Database.Database, url: string): string | null {
  const row = db
    .prepare('SELECT id FROM articles WHERE url = ? LIMIT 1')
    .get(url) as { id: string } | undefined
  return row?.id ?? null
}

// ── Crawl + persist ───────────────────────────────────────────────

/**
 * Calls the existing crawler, upserts the article row, and reports status.
 * Never throws — errors are captured in the returned `reason`.
 */
export async function crawlAndSaveArticle(
  db: Database.Database,
  url: string,
): Promise<{ article_id: string; status: 'ok' | 'failed'; reason?: string }> {
  try {
    const result = await crawlArticle(url)

    if (result.loginRequired) {
      return {
        article_id: url,
        status: 'failed',
        reason: 'login_required',
      }
    }

    if (!result.content || result.content.length < 50) {
      return {
        article_id: url,
        status: 'failed',
        reason: 'empty_content',
      }
    }

    upsertArticle(db, {
      id: url,
      tweet_id: null,
      author_id: null,
      author_username: result.author ?? null,
      content: result.content,
      source: 'crawl',
      url,
    })

    return { article_id: url, status: 'ok' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { article_id: url, status: 'failed', reason }
  }
}

// ── Per-tweet orchestration ───────────────────────────────────────

/**
 * Orchestrates detect → exists → crawl for a single tweet, across ALL
 * article-like URLs on the tweet.  Returns one ArticleResolution per URL.
 *
 *   - no URLs detected        → `[{ status: 'missing' }]` (single element)
 *   - URL already in articles → `{ status: 'ok', url, article_id }`
 *   - URL new                 → crawl; `{ status: 'ok' | 'failed', ... }`
 *
 * Each URL resolves independently — one failing crawl does not short-circuit
 * the others.  URL-level concurrency within a tweet is sequential here; the
 * tweet-level fan-out in `resolveArticlesForTweets` provides the outer
 * concurrency budget via articleIngestService.
 */
export async function resolveArticlesForTweet(
  db: Database.Database,
  tweet: DetectableTweet,
): Promise<ArticleResolution[]> {
  const urls = detectArticleUrls(tweet)
  if (urls.length === 0) {
    return [{ status: 'missing' }]
  }

  const out: ArticleResolution[] = []
  for (const url of urls) {
    if (articleExists(db, url)) {
      const existingId = getArticleIdByUrl(db, url) ?? url
      out.push({ status: 'ok', url, article_id: existingId })
      continue
    }

    const crawled = await crawlAndSaveArticle(db, url)
    if (crawled.status === 'ok') {
      out.push({ status: 'ok', url, article_id: crawled.article_id })
    } else {
      out.push({ status: 'failed', url, reason: crawled.reason })
    }
  }
  return out
}

/**
 * @deprecated Use `resolveArticlesForTweet` (plural). Returns only the first
 * resolution for callers that have not yet migrated to the one-to-many
 * contract.  Kept for compile-time compatibility during the X3→X4 transition.
 */
export async function resolveArticleForTweet(
  db: Database.Database,
  tweet: DetectableTweet,
): Promise<ArticleResolution> {
  const list = await resolveArticlesForTweet(db, tweet)
  return list[0] ?? { status: 'missing' }
}

/**
 * Concurrent fan-out of resolveArticlesForTweet across an array of tweets,
 * capped at 4 simultaneous crawlArticle calls (via articleIngestService).
 *
 * Side effect: persists one `tweet_articles` row per URL resolution that
 * carries a URL (i.e. every non-`missing` result).  Persistence is wrapped
 * in a try/catch so a DB write failure never cascades into the caller's
 * auto-crawl flow — the envelope is always returned.
 *
 * Post-X3 / v0.4.0: returns `TweetArticlesEnvelope` — an array of
 * `{ tweetId, articles }` entries — to model the one-to-many
 * tweet→articles relationship.  Replaces the prior `Map<tweet_id,
 * ArticleResolution[]>` return shape.
 */
export async function resolveArticlesForTweets(
  db: Database.Database,
  tweets: DetectableTweet[],
  concurrency = 4,
): Promise<TweetArticlesEnvelope> {
  const service = articleIngestService({ concurrency, resolver: resolveArticlesForTweet })
  const envelope = await service.ingestForTweets(db, tweets)

  // Persist each resolution to tweet_articles.  One row per URL — `missing`
  // resolutions have no URL/article_id and so are NOT written (the tweet's
  // overall status is already captured in tweets.article_crawl_status).
  for (const { tweetId, articles } of envelope) {
    for (const r of articles) {
      if (r.status === 'missing') continue
      const url = r.url
      const articleId = r.article_id ?? url
      if (!url || !articleId) continue
      try {
        insertTweetArticle(
          db,
          tweetId,
          articleId,
          url,
          r.status === 'ok' ? 'ok' : 'failed',
          r.reason ?? null,
        )
      } catch (err) {
        // DB write failures must never break the caller's response path.
        process.stderr.write(
          `x-api: insertTweetArticle failed (tweet=${tweetId} url=${url}): ${err}\n`,
        )
      }
    }
  }

  return envelope
}

// ── Output formatting ─────────────────────────────────────────────

/**
 * Formats the full articles[] array for a tweet into a multi-line string block.
 * Returns an empty string when the array is empty or contains only a single
 * `missing` entry (no article URLs were detected on the tweet).
 *
 * Output shape (one line per article, 1-indexed):
 *   \n  articles[1]: ok url=https://... id=https://...
 *   \n  articles[2]: failed url=https://... reason=login_required
 *
 * For a tweet with a single ok resolution the output mirrors the old singular
 * format closely, making diffs readable.
 */
export function formatArticlesLines(resolutions: ArticleResolution[]): string {
  if (!resolutions || resolutions.length === 0) return ''
  // Single missing entry — no article URLs on the tweet; omit entirely
  if (resolutions.length === 1 && resolutions[0].status === 'missing') return ''

  return resolutions
    .map((r, i) => {
      switch (r.status) {
        case 'ok': {
          const parts = [`  articles[${i + 1}]: ok`]
          if (r.url) parts.push(`url=${r.url}`)
          if (r.article_id) parts.push(`id=${r.article_id}`)
          return '\n' + parts.join(' ')
        }
        case 'failed': {
          const parts = [`  articles[${i + 1}]: failed`]
          if (r.url) parts.push(`url=${r.url}`)
          if (r.reason) parts.push(`reason=${r.reason}`)
          return '\n' + parts.join(' ')
        }
        case 'missing':
        default:
          return `\n  articles[${i + 1}]: missing`
      }
    })
    .join('')
}
