import type Database from 'better-sqlite3'
import type { XTweet, XIncludes } from '../../types.ts'
import type { TweetRow } from '../types.ts'
import { upsertUser } from './users.ts'
import { upsertMedia } from './media.ts'
import { upsertArticle } from './articles.ts'

export interface QueryTweetsOpts {
  query?: string
  author?: string
  source?: string
  limit?: number
  offset?: number
}

/**
 * Upserts a single tweet row.
 *
 * Uses INSERT … ON CONFLICT so that a later overwrite can't clobber
 * previously populated article_crawl_status with NULL — we COALESCE
 * the new value with the existing row value.
 */
export function upsertTweet(
  db: Database.Database,
  tweet: XTweet,
  source: string,
  articleCrawlStatus: string | null = null,
): void {
  const m = tweet.public_metrics
  db.prepare(`
    INSERT INTO tweets (
      id, text, note_tweet_text, author_id, conversation_id, created_at,
      retweet_count, reply_count, like_count, quote_count, impression_count, bookmark_count,
      entities_json, referenced_tweets_json, saved_at, source, article_crawl_status
    ) VALUES (
      @id, @text, @note_tweet_text, @author_id, @conversation_id, @created_at,
      @retweet_count, @reply_count, @like_count, @quote_count, @impression_count, @bookmark_count,
      @entities_json, @referenced_tweets_json, @saved_at, @source, @article_crawl_status
    )
    ON CONFLICT(id) DO UPDATE SET
      text                   = excluded.text,
      note_tweet_text        = excluded.note_tweet_text,
      author_id              = excluded.author_id,
      conversation_id        = excluded.conversation_id,
      created_at             = excluded.created_at,
      retweet_count          = excluded.retweet_count,
      reply_count            = excluded.reply_count,
      like_count             = excluded.like_count,
      quote_count            = excluded.quote_count,
      impression_count       = excluded.impression_count,
      bookmark_count         = excluded.bookmark_count,
      entities_json          = excluded.entities_json,
      referenced_tweets_json = excluded.referenced_tweets_json,
      saved_at               = excluded.saved_at,
      source                 = excluded.source,
      article_crawl_status   = COALESCE(excluded.article_crawl_status, tweets.article_crawl_status)
  `).run({
    id: tweet.id,
    text: tweet.text ?? null,
    note_tweet_text: tweet.note_tweet?.text ?? null,
    author_id: tweet.author_id ?? null,
    conversation_id: tweet.conversation_id ?? null,
    created_at: tweet.created_at ?? null,
    retweet_count: m?.retweet_count ?? null,
    reply_count: m?.reply_count ?? null,
    like_count: m?.like_count ?? null,
    quote_count: m?.quote_count ?? null,
    impression_count: m?.impression_count ?? null,
    bookmark_count: m?.bookmark_count ?? null,
    entities_json: tweet.entities ? JSON.stringify(tweet.entities) : null,
    referenced_tweets_json: tweet.referenced_tweets ? JSON.stringify(tweet.referenced_tweets) : null,
    saved_at: new Date().toISOString(),
    source,
    article_crawl_status: articleCrawlStatus,
  })
}

/**
 * Shared helper called by all tweet-returning tools.
 * Saves tweets, associated users, media, and article content from note_tweet.
 *
 * @param db                - Database instance from getDb()
 * @param tweets            - Array of XTweet objects from the API response data
 * @param includes          - Expanded includes (users, media, referenced tweets)
 * @param source            - Which tool produced this data: 'bookmarks'|'search'|'get_tweet'|'user_tweets'|'thread'
 * @param articleStatusMap  - Optional map of tweet id → article_crawl_status
 *                            ('pending' | 'ok' | 'missing' | 'failed'). When
 *                            absent, article_crawl_status is left untouched
 *                            on conflict (COALESCE preserves any prior value).
 *                            NOTE: first-article-only; for full per-URL status
 *                            query tweet_articles.
 */
export function upsertTweets(
  db: Database.Database,
  tweets: XTweet[],
  includes: XIncludes | undefined,
  source: string,
  articleStatusMap?: Map<string, string>,
): void {
  const saveAll = db.transaction(() => {
    // Save users from includes
    if (includes?.users) {
      for (const user of includes.users) {
        upsertUser(db, user)
      }
    }

    // Save each tweet and its media/articles
    for (const tweet of tweets) {
      const status = articleStatusMap?.get(tweet.id) ?? null
      upsertTweet(db, tweet, source, status)

      // Save media attached to this tweet
      if (tweet.attachments?.media_keys?.length && includes?.media) {
        const tweetMedia = includes.media.filter(
          (m) => tweet.attachments!.media_keys!.includes(m.media_key)
        )
        if (tweetMedia.length > 0) {
          upsertMedia(db, tweet.id, tweetMedia)
        }
      }

      // Save article content if note_tweet is present
      if (tweet.note_tweet?.text && tweet.author_id) {
        // Find author username from includes
        const author = includes?.users?.find((u) => u.id === tweet.author_id)
        upsertArticle(db, {
          id: tweet.id,
          tweet_id: tweet.id,
          author_id: tweet.author_id,
          author_username: author?.username ?? null,
          content: tweet.note_tweet.text,
          source: 'api',
          url: `https://x.com/i/article/${tweet.id}`,
        })
      }
    }

    // Also save referenced tweets if present in includes
    if (includes?.tweets) {
      for (const refTweet of includes.tweets) {
        upsertTweet(db, refTweet, source)
      }
    }
  })

  saveAll()
}

/**
 * Query saved tweets with optional filters.
 */
export function queryTweets(db: Database.Database, opts: QueryTweetsOpts = {}): TweetRow[] {
  const { query, author, source, limit = 20, offset = 0 } = opts

  const conditions: string[] = []
  const params: unknown[] = []

  if (query) {
    conditions.push('(t.text LIKE ? OR t.note_tweet_text LIKE ?)')
    params.push(`%${query}%`, `%${query}%`)
  }
  if (author) {
    conditions.push('u.username LIKE ?')
    params.push(`%${author}%`)
  }
  if (source) {
    conditions.push('t.source = ?')
    params.push(source)
  }

  if (author) {
    // Join with users table for author filter
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    params.push(limit, offset)
    return db.prepare(`
      SELECT t.* FROM tweets t
      LEFT JOIN users u ON t.author_id = u.id
      ${where}
      ORDER BY t.saved_at DESC
      LIMIT ? OFFSET ?
    `).all(...params) as TweetRow[]
  }

  // No author filter: no join needed
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
  params.push(limit, offset)
  return db.prepare(`
    SELECT * FROM tweets t
    ${where}
    ORDER BY t.saved_at DESC
    LIMIT ? OFFSET ?
  `).all(...params) as TweetRow[]
}
