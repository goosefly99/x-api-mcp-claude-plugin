import { getDb } from '../db/connection.ts'
import { queryTweets } from '../db/repos/tweets.ts'
import { queryUsers } from '../db/repos/users.ts'
import type { TweetRow, UserRow } from '../db/types.ts'

function formatSavedTweet(tweet: TweetRow, authorUsername?: string): string {
  const author = authorUsername ? `@${authorUsername}` : (tweet.author_id ?? 'unknown')
  const date = tweet.created_at ? new Date(tweet.created_at).toLocaleString() : ''
  const savedAt = new Date(tweet.saved_at).toLocaleDateString()
  const content = tweet.note_tweet_text ?? tweet.text ?? ''
  const isArticle = !!tweet.note_tweet_text
  const metrics = [
    tweet.like_count != null ? `Likes: ${tweet.like_count}` : '',
    tweet.retweet_count != null ? `RT: ${tweet.retweet_count}` : '',
    tweet.reply_count != null ? `Replies: ${tweet.reply_count}` : '',
  ].filter(Boolean).join(' | ')

  const parts = [
    `--- Tweet ${tweet.id} ---`,
    `Author: ${author}`,
    date ? `Date: ${date}` : '',
    `Saved: ${savedAt} [${tweet.source ?? 'unknown'}]`,
    isArticle ? '[Article]' : '',
    '',
    content,
    metrics ? `\n${metrics}` : '',
  ]

  return parts.filter(Boolean).join('\n')
}

export async function handleGetSavedTweets(args: Record<string, unknown>) {
  const query = args.query as string | undefined
  const author = args.author as string | undefined
  const source = args.source as string | undefined
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
  const offset = Math.max(0, Number(args.offset) || 0)

  let tweets
  try {
    tweets = queryTweets(getDb(), { query, author, source, limit, offset })
  } catch (err) {
    process.stderr.write(`x-api: DB query failed (get_saved_tweets): ${err}\n`)
    return {
      content: [{ type: 'text' as const, text: 'Database query failed. The DB may not be initialized yet.' }],
    }
  }

  if (tweets.length === 0) {
    const filters = [
      query ? `query="${query}"` : '',
      author ? `author="${author}"` : '',
      source ? `source="${source}"` : '',
    ].filter(Boolean).join(', ')
    const msg = filters ? `No saved tweets found matching ${filters}.` : 'No saved tweets found.'
    return {
      content: [{ type: 'text' as const, text: msg }],
    }
  }

  // Build a lookup of author usernames for the result set
  const authorIds = [...new Set(tweets.map((t) => t.author_id).filter(Boolean))] as string[]
  let users: UserRow[]
  try {
    users = authorIds.length > 0
      ? queryUsers(getDb(), { limit: authorIds.length + 10 })
      : []
  } catch {
    users = []
  }
  const userMap = new Map(users.map((u) => [u.id, u.username ?? '']))

  const formatted = tweets
    .map((t) => formatSavedTweet(t, t.author_id ? userMap.get(t.author_id) : undefined))
    .join('\n\n')

  return {
    content: [{
      type: 'text' as const,
      text: `${tweets.length} saved tweet(s) (offset ${offset}):\n\n${formatted}`,
    }],
  }
}
