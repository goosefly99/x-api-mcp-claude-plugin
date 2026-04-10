/**
 * Import script: loads curated x-posts JSON files into the SQLite DB.
 *
 * Sources:
 *   - trading_strategies.json          (raw bookmarks, file 1)
 *   - x-posts-trading-strategies-*.json (synth-enriched version of file 1)
 *   - agent_methods_x_posts.json        (AI/agent methods posts, file 3)
 *
 * Ownership: this script owns title, summary, tags_json, category, projects_json.
 * It never overwrites is_article, entities_json, or referenced_tweets_json set
 * by import-bookmarks.ts.
 *
 * Run: node scripts/import-posts.ts
 */

import fs from 'node:fs'
import { getDb } from '../db/connection.ts'
import { initSchema } from '../db/schema.ts'

const PROJECTS = {
  trading: ['ai_trading'],
  agentAi: ['claude_plugins_auto_dev', 'claude_plugins', 'agents', 'claude_plugins_python_versions'],
}

const FILE_TRADING_RAW      = 'C:/Users/olive/Documents/x_posts/trading_strategies.json'
const FILE_TRADING_ENRICHED = 'C:/Users/olive/Documents/ai_trading/strategies/collections/raw/x-posts-trading-strategies--1428c413.json'
const FILE_AGENT_METHODS    = 'C:/Users/olive/Documents/claude_plugins_auto_dev/agent_research_outputs/agent_methods_x_posts.json'

function parseDate(raw: string): string {
  try { return new Date(raw).toISOString() } catch { return raw }
}
function handle(raw: string): string {
  return raw.replace(/^@/, '')
}

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

// Owns enrichment fields. Never touches is_article, entities_json,
// referenced_tweets_json — those belong to import-bookmarks.ts.
const upsertTweet = db.prepare(`
  INSERT INTO tweets (
    id, text, author_id, conversation_id, created_at,
    like_count, retweet_count, reply_count,
    source, saved_at,
    title, summary, tags_json, category, projects_json
  ) VALUES (
    @id, @text, @author_id, @conversation_id, @created_at,
    @like_count, @retweet_count, @reply_count,
    @source, @saved_at,
    @title, @summary, @tags_json, @category, @projects_json
  )
  ON CONFLICT(id) DO UPDATE SET
    title         = excluded.title,
    summary       = excluded.summary,
    tags_json     = excluded.tags_json,
    category      = excluded.category,
    projects_json = excluded.projects_json,
    text          = COALESCE(tweets.text,          excluded.text),
    author_id     = COALESCE(tweets.author_id,     excluded.author_id),
    created_at    = COALESCE(tweets.created_at,    excluded.created_at),
    like_count    = COALESCE(tweets.like_count,    excluded.like_count),
    retweet_count = COALESCE(tweets.retweet_count, excluded.retweet_count),
    reply_count   = COALESCE(tweets.reply_count,   excluded.reply_count)
`)

// ── FILE 1 + FILE 2: Trading strategies ──────────────────────────────────

interface RawPost {
  tweet_id: string
  date: string
  profile: { handle: string; display_name: string; bio: string }
  content: string
  engagement: { likes: number; retweets: number; replies: number }
  conversation_id: string
}
interface EnrichedItem {
  title: string
  tags: string[]
  metadata: {
    tweet_id: string
    summary: string
    engagement: { likes: number; retweets: number; replies: number }
    conversation_id: string
  }
}

const rawTrading      = JSON.parse(fs.readFileSync(FILE_TRADING_RAW,      'utf8')) as { posts: RawPost[] }
const enrichedTrading = JSON.parse(fs.readFileSync(FILE_TRADING_ENRICHED, 'utf8')) as { items: EnrichedItem[] }

const enrichmentMap = new Map<string, EnrichedItem>()
for (const item of enrichedTrading.items) {
  enrichmentMap.set(item.metadata.tweet_id, item)
}

db.transaction(() => {
  for (const post of rawTrading.posts) {
    const enriched = enrichmentMap.get(post.tweet_id)
    const userId   = handle(post.profile.handle)
    upsertUser.run({ id: userId, name: post.profile.display_name, username: userId, description: post.profile.bio, saved_at: now })
    upsertTweet.run({
      id: post.tweet_id, text: post.content, author_id: userId,
      conversation_id: post.conversation_id, created_at: parseDate(post.date),
      like_count: post.engagement.likes, retweet_count: post.engagement.retweets, reply_count: post.engagement.replies,
      source: 'bookmarks', saved_at: now,
      title: enriched?.title ?? null, summary: enriched?.metadata.summary ?? null,
      tags_json: enriched ? JSON.stringify(enriched.tags) : null,
      category: 'trading-strategy', projects_json: JSON.stringify(PROJECTS.trading),
    })
  }
})()
console.log(`Trading posts upserted: ${rawTrading.posts.length}`)

// ── FILE 3: Agent methods ─────────────────────────────────────────────────

interface AgentPost {
  tweet_id: string; author: string; date: string
  title: string; summary: string; tags: string[]
  raw_excerpt: string
}

const agentData = JSON.parse(fs.readFileSync(FILE_AGENT_METHODS, 'utf8')) as { posts: AgentPost[] }

db.transaction(() => {
  for (const post of agentData.posts) {
    const userId = handle(post.author)
    upsertUser.run({ id: userId, name: null, username: userId, description: null, saved_at: now })
    upsertTweet.run({
      id: post.tweet_id, text: post.raw_excerpt, author_id: userId,
      conversation_id: post.tweet_id, created_at: parseDate(post.date),
      like_count: null, retweet_count: null, reply_count: null,
      source: 'bookmarks', saved_at: now,
      title: post.title, summary: post.summary, tags_json: JSON.stringify(post.tags),
      category: 'agentic-ai', projects_json: JSON.stringify(PROJECTS.agentAi),
    })
  }
})()
console.log(`Agent methods posts upserted: ${agentData.posts.length}`)

// ── Summary ───────────────────────────────────────────────────────────────

const counts = db.prepare(`
  SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as cnt
  FROM tweets GROUP BY cat ORDER BY cnt DESC
`).all() as { cat: string; cnt: number }[]
console.log('\nBy category:')
for (const row of counts) console.log(`  ${row.cat}: ${row.cnt}`)
const total = (db.prepare('SELECT COUNT(*) as c FROM tweets').get() as { c: number }).c
const users = (db.prepare('SELECT COUNT(*) as c FROM users').get()  as { c: number }).c
console.log(`\nTotal tweets: ${total} | Total users: ${users}`)
