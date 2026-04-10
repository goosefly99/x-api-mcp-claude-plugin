import { getDb } from '../db/connection.ts'
import { queryUsers } from '../db/repos/users.ts'
import type { UserRow } from '../db/types.ts'

function formatSavedUser(user: UserRow): string {
  const verified = user.verified === 1 ? ' [verified]' : ''
  const savedAt = new Date(user.saved_at).toLocaleDateString()
  const metrics = [
    user.followers_count != null ? `Followers: ${user.followers_count}` : '',
    user.following_count != null ? `Following: ${user.following_count}` : '',
    user.tweet_count != null ? `Tweets: ${user.tweet_count}` : '',
  ].filter(Boolean).join(' | ')

  const parts = [
    `--- @${user.username ?? user.id}${verified} ---`,
    user.name ? `Name: ${user.name}` : '',
    user.description ? `Bio: ${user.description}` : '',
    user.location ? `Location: ${user.location}` : '',
    user.url ? `URL: ${user.url}` : '',
    metrics,
    user.created_at ? `Joined: ${new Date(user.created_at).toLocaleDateString()}` : '',
    `Saved: ${savedAt}`,
  ]

  return parts.filter(Boolean).join('\n')
}

export async function handleGetSavedUsers(args: Record<string, unknown>) {
  const query = args.query as string | undefined
  const limit = Math.max(1, Math.min(100, Number(args.limit) || 20))
  const offset = Math.max(0, Number(args.offset) || 0)

  let users
  try {
    users = queryUsers(getDb(), { query, limit, offset })
  } catch (err) {
    process.stderr.write(`x-api: DB query failed (get_saved_users): ${err}\n`)
    return {
      content: [{ type: 'text' as const, text: 'Database query failed. The DB may not be initialized yet.' }],
    }
  }

  if (users.length === 0) {
    const msg = query ? `No saved users found matching "${query}".` : 'No saved users found.'
    return {
      content: [{ type: 'text' as const, text: msg }],
    }
  }

  const formatted = users.map(formatSavedUser).join('\n\n')

  return {
    content: [{
      type: 'text' as const,
      text: `${users.length} saved user(s) (offset ${offset}):\n\n${formatted}`,
    }],
  }
}
