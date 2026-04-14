/**
 * TypeScript row interfaces matching the SQLite DDL in schema.ts.
 * These represent the shape of rows as returned by better-sqlite3 queries.
 */

export interface TweetRow {
  id: string
  text: string | null
  note_tweet_text: string | null
  author_id: string | null
  conversation_id: string | null
  created_at: string | null
  retweet_count: number | null
  reply_count: number | null
  like_count: number | null
  quote_count: number | null
  impression_count: number | null
  bookmark_count: number | null
  entities_json: string | null
  referenced_tweets_json: string | null
  saved_at: string
  source: string | null
  // v2 enrichment columns
  title: string | null
  summary: string | null
  tags_json: string | null
  category: string | null
  projects_json: string | null
  // v3
  is_article: number | null
  // v4
  article_crawl_status: string | null
}

export interface UserRow {
  id: string
  name: string | null
  username: string | null
  description: string | null
  followers_count: number | null
  following_count: number | null
  tweet_count: number | null
  profile_image_url: string | null
  verified: number | null
  created_at: string | null
  url: string | null
  location: string | null
  saved_at: string
}

export interface ArticleRow {
  id: string
  tweet_id: string | null
  author_id: string | null
  author_username: string | null
  content: string | null
  source: string | null
  url: string | null
  saved_at: string
}

export interface MediaRow {
  media_key: string
  tweet_id: string | null
  type: string | null
  url: string | null
  preview_image_url: string | null
  alt_text: string | null
}
