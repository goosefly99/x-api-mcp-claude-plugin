import { xApiRequest, TWEET_FIELDS, USER_FIELDS, EXPANSIONS, MEDIA_FIELDS } from '../client.ts'
import type { XTweet } from '../types.ts'
import { getDb } from '../db/connection.ts'
import { upsertArticle } from '../db/repos/articles.ts'
import { upsertTweets } from '../db/repos/tweets.ts'

export async function handleGetArticle(args: Record<string, unknown>) {
  let articleId = args.article_id as string
  if (!articleId) throw new Error('article_id is required')

  // Strip URL prefix if full URL provided (e.g. https://x.com/i/article/2039029453540532224)
  const urlMatch = articleId.match(/\/article\/(\d+)/)
  if (urlMatch) {
    articleId = urlMatch[1]
  }

  const { response, rateLimit } = await xApiRequest<XTweet>(
    `tweets/${encodeURIComponent(articleId)}`,
    {
      'tweet.fields': TWEET_FIELDS,
      'user.fields': USER_FIELDS,
      expansions: EXPANSIONS,
      'media.fields': MEDIA_FIELDS,
    },
    'app'
  )

  if (!response.data) {
    return {
      content: [{
        type: 'text' as const,
        text: `Article ${articleId} not found. The ID may not correspond to a valid tweet, or X Articles may require a different endpoint. Try using x_get_tweet with this ID to inspect the raw response.`,
      }],
    }
  }

  const tweet = response.data
  const author = response.includes?.users?.find((u) => u.id === tweet.author_id)
  const authorStr = author ? `@${author.username} (${author.name})` : tweet.author_id ?? 'unknown'
  const date = tweet.created_at ? new Date(tweet.created_at).toLocaleDateString() : ''
  const metrics = tweet.public_metrics
    ? `  Likes: ${tweet.public_metrics.like_count} | RT: ${tweet.public_metrics.retweet_count} | Replies: ${tweet.public_metrics.reply_count}`
    : ''

  if (!tweet.note_tweet?.text) {
    // Not an article — return what we have with a note
    const parts = [
      `Tweet ${articleId} is not an X Article (no note_tweet content).`,
      `Regular tweet text: ${tweet.text}`,
      ``,
      `If this is a valid article URL, the article content may require a different API endpoint.`,
    ]
    const rateLimitInfo = `\n\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`
    return {
      content: [{ type: 'text' as const, text: parts.join('\n') + rateLimitInfo }],
    }
  }

  // Persist tweet and article to DB
  try {
    upsertTweets(getDb(), [tweet], response.includes, 'get_tweet')
    upsertArticle(getDb(), {
      id: tweet.id,
      tweet_id: tweet.id,
      author_id: tweet.author_id ?? null,
      author_username: author?.username ?? null,
      content: tweet.note_tweet.text,
      source: 'api',
      url: `https://x.com/i/article/${tweet.id}`,
    })
  } catch (err) {
    process.stderr.write(`x-api: DB save failed (get_article): ${err}\n`)
  }

  // Format article links from note_tweet entities
  const articleUrls = tweet.note_tweet.entities?.urls
    ?.map((u) => `  ${u.display_url} → ${u.expanded_url}`)
    ?.join('\n') ?? ''

  const parts = [
    `--- Article by ${authorStr} ---`,
    date ? `Date: ${date}` : '',
    author?.description ? `Bio: ${author.description}` : '',
    '',
    '[Article Content]',
    tweet.note_tweet.text,
    metrics ? `\n${metrics}` : '',
    articleUrls ? `\nLinks in article:\n${articleUrls}` : '',
  ]

  const rateLimitInfo = `\n\n[Rate limit: ${rateLimit.remaining}/${rateLimit.limit} remaining]`

  return {
    content: [{
      type: 'text' as const,
      text: parts.filter(Boolean).join('\n') + rateLimitInfo,
    }],
  }
}
