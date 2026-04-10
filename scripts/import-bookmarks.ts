/**
 * Import script: loads bookmarks.json into the SQLite DB.
 * Source: agent_research_outputs/bookmarks.json
 *
 * Ownership: this script owns is_article, source, entities_json,
 * referenced_tweets_json, and media rows. It never overwrites
 * category, projects_json, title, summary, or tags_json set by
 * import-posts.ts.
 *
 * Run: node scripts/import-bookmarks.ts
 */

import fs from 'node:fs'
import { getDb } from '../db/connection.ts'
import { initSchema } from '../db/schema.ts'

const FILE = 'C:/Users/olive/Documents/claude_plugins_auto_dev/agent_research_outputs/bookmarks.json'

interface MediaItem   { type: 'photo' | 'video' | 'gif'; url: string }
interface LinkItem    { display: string; url: string }
interface QuotedTweet { id: string; author: string; body: string | null; media: MediaItem[]; links: LinkItem[] }
interface BookmarkTweet {
  id: string
  author_handle: string
  author_name: string | null
  bio: string | null
  date: string
  thread_id: string
  is_article: boolean
  body: string | null
  likes: number | null
  retweets: number | null
  replies: number | null
  quoted_tweet: QuotedTweet | null
  media: MediaItem[]
  links: LinkItem[]
  source_file: string
}
interface BookmarksFile { total: number; tweets: BookmarkTweet[] }

const db = getDb()
initSchema(db)
const now = new Date().toISOString()

const upsertUser = db.prepare(`
  INSERT INTO users (id, name, username, description, saved_at)
  VALUES (@id, @name, @username, @description, @saved_at)
  ON CONFLICT(id) DO UPDATE SET
    name        = COALESCE(excluded.name, users.name),
    description = COALESCE(excluded.description, users.description),
    saved_at    = excluded.saved_at
`)

// Owns is_article, source, entities_json, referenced_tweets_json.
// Never touches category, projects_json, title, summary, tags_json.
const upsertTweet = db.prepare(`
  INSERT INTO tweets (
    id, text, author_id, conversation_id, created_at,
    like_count, retweet_count, reply_count,
    entities_json, referenced_tweets_json,
    source, saved_at, is_article
  ) VALUES (
    @id, @text, @author_id, @conversation_id, @created_at,
    @like_count, @retweet_count, @reply_count,
    @entities_json, @referenced_tweets_json,
    @source, @saved_at, @is_article
  )
  ON CONFLICT(id) DO UPDATE SET
    is_article             = excluded.is_article,
    source                 = excluded.source,
    entities_json          = COALESCE(tweets.entities_json,          excluded.entities_json),
    referenced_tweets_json = COALESCE(tweets.referenced_tweets_json, excluded.referenced_tweets_json),
    text                   = COALESCE(tweets.text,          excluded.text),
    created_at             = COALESCE(tweets.created_at,    excluded.created_at),
    conversation_id        = COALESCE(tweets.conversation_id, excluded.conversation_id),
    like_count             = COALESCE(excluded.like_count,   tweets.like_count),
    retweet_count          = COALESCE(excluded.retweet_count, tweets.retweet_count),
    reply_count            = COALESCE(excluded.reply_count,  tweets.reply_count)
`)

const insertMedia = db.prepare(`
  INSERT OR IGNORE INTO media (media_key, tweet_id, type, url)
  VALUES (@media_key, @tweet_id, @type, @url)
`)

const { tweets } = JSON.parse(fs.readFileSync(FILE, 'utf8')) as BookmarksFile

db.transaction(() => {
  for (const t of tweets) {
    upsertUser.run({
      id: t.author_handle, name: t.author_name ?? null,
      username: t.author_handle, description: t.bio ?? null, saved_at: now,
    })

    upsertTweet.run({
      id:                     t.id,
      text:                   t.body ?? null,
      author_id:              t.author_handle,
      conversation_id:        t.thread_id,
      created_at:             (() => { try { return new Date(t.date).toISOString() } catch { return t.date } })(),
      like_count:             t.likes ?? null,
      retweet_count:          t.retweets ?? null,
      reply_count:            t.replies ?? null,
      entities_json:          t.links.length ? JSON.stringify(t.links) : null,
      referenced_tweets_json: t.quoted_tweet ? JSON.stringify(t.quoted_tweet) : null,
      source:                 `bookmarks:${t.source_file}`,
      saved_at:               now,
      is_article:             t.is_article ? 1 : 0,
    })

    for (let i = 0; i < t.media.length; i++) {
      insertMedia.run({ media_key: `${t.id}_${i}`, tweet_id: t.id, type: t.media[i].type, url: t.media[i].url })
    }
  }
})()

// ── Summary ───────────────────────────────────────────────────────────────

const total     = (db.prepare('SELECT COUNT(*) as c FROM tweets').get()  as { c: number }).c
const users     = (db.prepare('SELECT COUNT(*) as c FROM users').get()   as { c: number }).c
const mediaRows = (db.prepare('SELECT COUNT(*) as c FROM media').get()   as { c: number }).c
const articles  = (db.prepare('SELECT COUNT(*) as c FROM tweets WHERE is_article = 1').get() as { c: number }).c
const byCat     = db.prepare(`
  SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as c
  FROM tweets GROUP BY cat ORDER BY c DESC
`).all() as { cat: string; c: number }[]
const version   = (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number }).v

console.log(`Imported: ${tweets.length} bookmarks (${articles} total articles in DB)`)
console.log(`\nDB totals — tweets: ${total} | users: ${users} | media: ${mediaRows}`)
console.log('\nBy category:')
for (const row of byCat) console.log(`  ${row.cat}: ${row.c}`)
console.log(`\nSchema version: ${version}`)
