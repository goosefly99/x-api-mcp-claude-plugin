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
import type { XTweet } from '../types.ts'
import { crawlArticle } from '../crawler.ts'
import { upsertArticle } from '../db/repos/articles.ts'
import { articleIngestService } from './articleIngestService.ts'

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
 * Returns the first URL in the tweet that looks like an X Article
 * (x.com/:user/status/:id/article/:num or legacy twitter.com form)
 * or a qualifying external article URL. Returns null when nothing matches.
 */
export function detectArticleUrl(tweet: DetectableTweet): string | null {
  const urls = collectCandidateUrls(tweet)
  // Prefer X-native article URLs over external ones.
  for (const u of urls) {
    if (isXArticleUrl(u)) return u
  }
  for (const u of urls) {
    if (isQualifyingExternalArticleUrl(u)) return u
  }
  return null
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
 * Orchestrates detect → exists → crawl for a single tweet.
 *   - no URL detected         → status: 'missing'
 *   - URL already in articles → status: 'ok' (no crawl)
 *   - URL new                 → crawl; status: 'ok' | 'failed'
 */
export async function resolveArticleForTweet(
  db: Database.Database,
  tweet: DetectableTweet,
): Promise<ArticleResolution> {
  const url = detectArticleUrl(tweet)
  if (!url) {
    return { status: 'missing' }
  }

  if (articleExists(db, url)) {
    const existingId = getArticleIdByUrl(db, url) ?? url
    return { status: 'ok', url, article_id: existingId }
  }

  const crawled = await crawlAndSaveArticle(db, url)
  if (crawled.status === 'ok') {
    return { status: 'ok', url, article_id: crawled.article_id }
  }
  return { status: 'failed', url, reason: crawled.reason }
}

/**
 * Concurrent fan-out of resolveArticleForTweet across an array of tweets,
 * capped at 4 simultaneous crawlArticle calls (via articleIngestService).
 *
 * The concurrency cap can be overridden via the optional second argument.
 * Callers that previously relied on sequential behavior will now benefit
 * from parallelism up to the cap without any API change.
 */
export async function resolveArticlesForTweets(
  db: Database.Database,
  tweets: DetectableTweet[],
  concurrency = 4,
): Promise<Map<string, ArticleResolution>> {
  const service = articleIngestService({ concurrency })
  return service.ingestForTweets(db, tweets)
}

// ── Output formatting ─────────────────────────────────────────────

/**
 * Produces the one-line summary appended to the tool text output.
 * Examples:
 *   '  article: ok url=https://x.com/.../article/123 id=https://x.com/.../article/123'
 *   '  article: missing'
 *   '  article: failed url=https://... reason=login_required'
 */
export function formatArticleLine(result: ArticleResolution): string {
  switch (result.status) {
    case 'ok': {
      const parts = ['  article: ok']
      if (result.url) parts.push(`url=${result.url}`)
      if (result.article_id) parts.push(`id=${result.article_id}`)
      return parts.join(' ')
    }
    case 'failed': {
      const parts = ['  article: failed']
      if (result.url) parts.push(`url=${result.url}`)
      if (result.reason) parts.push(`reason=${result.reason}`)
      return parts.join(' ')
    }
    case 'missing':
    default:
      return '  article: missing'
  }
}
