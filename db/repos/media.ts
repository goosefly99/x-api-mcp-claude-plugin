import type Database from 'better-sqlite3'
import type { XMedia } from '../../types.ts'

/**
 * Upserts all media objects associated with a tweet.
 * @param db    - Database instance from getDb()
 * @param tweetId - The tweet that owns this media
 * @param media   - Array of XMedia objects from API includes
 */
export function upsertMedia(db: Database.Database, tweetId: string, media: XMedia[]): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO media (media_key, tweet_id, type, url, preview_image_url, alt_text)
    VALUES (@media_key, @tweet_id, @type, @url, @preview_image_url, @alt_text)
  `)

  const run = db.transaction((items: XMedia[]) => {
    for (const m of items) {
      // For videos/gifs, pick best URL from variants
      let url = m.url ?? null
      if (!url && m.variants?.length) {
        const best = m.variants
          .filter((v) => v.content_type === 'video/mp4')
          .sort((a, b) => (b.bit_rate ?? 0) - (a.bit_rate ?? 0))[0]
        url = best?.url ?? m.preview_image_url ?? null
      }

      stmt.run({
        media_key: m.media_key,
        tweet_id: tweetId,
        type: m.type,
        url,
        preview_image_url: m.preview_image_url ?? null,
        alt_text: m.alt_text ?? null,
      })
    }
  })

  run(media)
}
