import { xApiRequest, formatTweet, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XTweet } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertTweets } from '../db/repos/tweets.ts'
import { resolveArticlesForTweets, formatArticleLine, type ArticleResolution } from '../services/auto-crawl.ts'

export async function handleGetThread(args: Record<string, unknown>) {
  const tweetId = args.tweet_id as string
  if (!tweetId) throw new Error('tweet_id is required')

  const maxResults = Math.max(10, Math.min(100, Number(args.max_results) || 50))
  const autoCrawl = args.auto_crawl_articles !== false

  const params: Record<string, string | undefined> = {
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    expansions: EXPANSIONS,
    'media.fields': MEDIA_FIELDS,
  }

  // Step 1: Fetch the given tweet to get its conversation_id
  const { response: seedResponse } = await xApiRequest<XTweet>(
    `tweets/${encodeURIComponent(tweetId)}`,
    params,
    'app'
  )

  if (!seedResponse.data) {
    return {
      content: [{ type: 'text' as const, text: `Tweet ${tweetId} not found.` }],
    }
  }

  const conversationId = seedResponse.data.conversation_id
  if (!conversationId) {
    // No conversation_id — return the single tweet
    const formatted = formatTweet(seedResponse.data, seedResponse.includes)
    return {
      content: [{
        type: 'text' as const,
        text: `Could not determine thread (no conversation_id). Single tweet:\n\n${formatted}`,
      }],
    }
  }

  // Step 2: Search for all tweets in this conversation (last 7 days only)
  const { response: threadResponse, rateLimit } = await xApiRequest<XTweet[]>(
    'tweets/search/recent',
    {
      query: `conversation_id:${conversationId}`,
      max_results: String(maxResults),
      ...params,
    },
    'app'
  )

  // Collect all tweets: search results + the seed tweet
  const allTweets: XTweet[] = []
  const seenIds = new Set<string>()

  // Merge includes from both responses
  const mergedIncludes = {
    users: [
      ...(seedResponse.includes?.users ?? []),
      ...(threadResponse.includes?.users ?? []),
    ],
    tweets: [
      ...(seedResponse.includes?.tweets ?? []),
      ...(threadResponse.includes?.tweets ?? []),
    ],
    media: [
      ...(seedResponse.includes?.media ?? []),
      ...(threadResponse.includes?.media ?? []),
    ],
  }

  // Add search results
  if (threadResponse.data) {
    for (const tweet of threadResponse.data) {
      if (!seenIds.has(tweet.id)) {
        seenIds.add(tweet.id)
        allTweets.push(tweet)
      }
    }
  }

  // Add the seed tweet if not already present
  if (!seenIds.has(seedResponse.data.id)) {
    seenIds.add(seedResponse.data.id)
    allTweets.push(seedResponse.data)
  }

  // Step 3: If the root tweet (conversation_id === id) isn't in results, fetch it
  if (!seenIds.has(conversationId)) {
    try {
      const { response: rootResponse } = await xApiRequest<XTweet>(
        `tweets/${encodeURIComponent(conversationId)}`,
        params,
        'app'
      )
      if (rootResponse.data) {
        allTweets.push(rootResponse.data)
        if (rootResponse.includes?.users) mergedIncludes.users.push(...rootResponse.includes.users)
        if (rootResponse.includes?.tweets) mergedIncludes.tweets.push(...rootResponse.includes.tweets)
        if (rootResponse.includes?.media) mergedIncludes.media.push(...rootResponse.includes.media)
      }
    } catch {
      // Root tweet may be older than 7 days or deleted — continue without it
    }
  }

  // Step 4: Sort chronologically
  allTweets.sort((a, b) => {
    const dateA = a.created_at ? new Date(a.created_at).getTime() : 0
    const dateB = b.created_at ? new Date(b.created_at).getTime() : 0
    return dateA - dateB
  })

  // Step 5: Resolve articles BEFORE persisting so article_crawl_status
  // lands in the same transaction as the tweet rows.
  const db = getDb()
  let articleMap = new Map<string, ArticleResolution>()
  if (autoCrawl) {
    try {
      articleMap = await resolveArticlesForTweets(db, allTweets)
    } catch (err) {
      process.stderr.write(`x-api: auto-crawl failed (thread): ${err}\n`)
    }
  }

  const statusMap = new Map<string, string>()
  for (const [id, res] of articleMap) statusMap.set(id, res.status)

  // Persist to DB
  try {
    upsertTweets(db, allTweets, mergedIncludes, 'thread', statusMap)
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (thread): ${err}\n`)
  }

  // Step 6: Format output
  const formatted = allTweets
    .map((t) => {
      const line = articleMap.has(t.id)
        ? `\n${formatArticleLine(articleMap.get(t.id)!)}`
        : ''
      return `${formatTweet(t, mergedIncludes)}${line}`
    })
    .join('\n\n')

  const note = allTweets.length < (threadResponse.meta?.result_count ?? 0)
    ? '\n\n⚠ Some tweets in this thread may be missing (search only covers the last 7 days).'
    : ''
  const rateLimitInfo = `\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{
      type: 'text' as const,
      text: `Thread ${conversationId} (${allTweets.length} tweets):\n\n${formatted}${note}${rateLimitInfo}`,
    }],
  }
}
