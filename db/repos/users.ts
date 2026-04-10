import type Database from 'better-sqlite3'
import type { XUser } from '../../types.ts'
import type { UserRow } from '../types.ts'

export interface QueryUsersOpts {
  query?: string
  limit?: number
  offset?: number
}

/**
 * Upserts a single user. Safe to call multiple times with the same user.
 */
export function upsertUser(db: Database.Database, user: XUser): void {
  db.prepare(`
    INSERT OR REPLACE INTO users (
      id, name, username, description,
      followers_count, following_count, tweet_count,
      profile_image_url, verified, created_at, url, location, saved_at
    ) VALUES (
      @id, @name, @username, @description,
      @followers_count, @following_count, @tweet_count,
      @profile_image_url, @verified, @created_at, @url, @location, @saved_at
    )
  `).run({
    id: user.id,
    name: user.name ?? null,
    username: user.username ?? null,
    description: user.description ?? null,
    followers_count: user.public_metrics?.followers_count ?? null,
    following_count: user.public_metrics?.following_count ?? null,
    tweet_count: user.public_metrics?.tweet_count ?? null,
    profile_image_url: user.profile_image_url ?? null,
    verified: user.verified ? 1 : 0,
    created_at: user.created_at ?? null,
    url: user.url ?? null,
    location: user.location ?? null,
    saved_at: new Date().toISOString(),
  })
}

/**
 * Query saved users with optional full-text search across username, name, and description.
 */
export function queryUsers(db: Database.Database, opts: QueryUsersOpts = {}): UserRow[] {
  const { query, limit = 20, offset = 0 } = opts

  if (query) {
    const like = `%${query}%`
    return db.prepare(`
      SELECT * FROM users
      WHERE username LIKE ? OR name LIKE ? OR description LIKE ?
      ORDER BY saved_at DESC
      LIMIT ? OFFSET ?
    `).all(like, like, like, limit, offset) as UserRow[]
  }

  return db.prepare(`
    SELECT * FROM users
    ORDER BY saved_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as UserRow[]
}
