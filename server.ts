import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { handleAuthorize } from './tools/authorize.ts'
import { handleGetBookmarks } from './tools/bookmarks.ts'
import { handleSearchTweets } from './tools/search.ts'
import { handleGetTweet, handleGetUserTweets } from './tools/tweets.ts'
import { handleGetUser } from './tools/users.ts'
import { handleGetThread } from './tools/thread.ts'
import { handleGetArticle } from './tools/article.ts'
import { handleBrowserLogin, handleCrawlArticle } from './tools/crawl.ts'
import { handleGetSavedTweets } from './tools/saved_tweets.ts'
import { handleGetSavedArticles } from './tools/saved_articles.ts'
import { handleGetSavedUsers } from './tools/saved_users.ts'
import { closeBrowser } from './crawler.ts'
import { getDb, getDbPath } from './db/connection.ts'
import { initSchema } from './db/schema.ts'

// Validate required env vars
const requiredEnv = ['X_API_CONSUMER_KEY', 'X_API_SECRET_KEY', 'X_O_AUTH_2_0_CLIENT_ID']
const missingEnv = requiredEnv.filter((k) => !process.env[k])
if (missingEnv.length > 0) {
  process.stderr.write(`x-api: Missing required env vars: ${missingEnv.join(', ')}\n`)
  process.exit(1)
}

const server = new Server(
  { name: 'x-api', version: '0.0.1' },
  {
    capabilities: { tools: {} },
    instructions:
      'X (Twitter) API MCP Server. Provides tools to search tweets, look up users, ' +
      'read bookmarks, fetch individual tweets, retrieve full threads, and read X Articles. ' +
      'Use x_authorize to connect your X account before accessing bookmarks.',
  }
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'x_authorize',
      description:
        'Authorize Claude to access your X (Twitter) account via OAuth 2.0. ' +
        'Required before using x_get_bookmarks. Opens your browser for authentication.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'x_get_bookmarks',
      description:
        'Get your X bookmarks. Requires authorization (run x_authorize first). ' +
        'Returns bookmarked tweets with author info and engagement metrics.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          max_results: {
            type: 'number',
            description: 'Number of bookmarks to return (1-100, default 20)',
            minimum: 1,
            maximum: 100,
          },
          next_token: {
            type: 'string',
            description: 'Pagination token from a previous response',
          },
        },
      },
    },
    {
      name: 'x_search_tweets',
      description:
        'Search recent tweets (last 7 days). Supports X search operators like ' +
        '"from:username", "has:links", "#hashtag", "is:verified".',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Search query (supports X search operators)',
          },
          max_results: {
            type: 'number',
            description: 'Number of results (10-100, default 10)',
            minimum: 10,
            maximum: 100,
          },
          next_token: {
            type: 'string',
            description: 'Pagination token from a previous response',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'x_get_tweet',
      description:
        'Get a single tweet by ID. Returns full tweet text, author, engagement metrics, and URLs.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          tweet_id: {
            type: 'string',
            description: 'The tweet ID to look up',
          },
        },
        required: ['tweet_id'],
      },
    },
    {
      name: 'x_get_user_tweets',
      description:
        'Get recent tweets from a user by their user ID. Use x_get_user to look up user IDs from usernames.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          user_id: {
            type: 'string',
            description: 'The user ID (numeric). Use x_get_user to find this from a username.',
          },
          max_results: {
            type: 'number',
            description: 'Number of tweets (5-100, default 10)',
            minimum: 5,
            maximum: 100,
          },
          next_token: {
            type: 'string',
            description: 'Pagination token from a previous response',
          },
        },
        required: ['user_id'],
      },
    },
    {
      name: 'x_get_user',
      description:
        'Look up an X user by username. Returns profile info, bio, location, URL, follower/following counts, and pinned tweet. Strips leading @ automatically.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          username: {
            type: 'string',
            description: 'The X username (with or without @)',
          },
        },
        required: ['username'],
      },
    },
    {
      name: 'x_get_thread',
      description:
        'Get a full conversation thread given any tweet ID in the thread. Returns all tweets in the conversation sorted chronologically. Note: only searches last 7 days of tweets.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          tweet_id: {
            type: 'string',
            description: 'Any tweet ID from the thread',
          },
          max_results: {
            type: 'number',
            description: 'Maximum replies to fetch (10-100, default 50)',
            minimum: 10,
            maximum: 100,
          },
        },
        required: ['tweet_id'],
      },
    },
    {
      name: 'x_get_article',
      description:
        'Get the full content of an X Article (long-form post) via API. Accepts an article ID or full x.com/i/article/ URL. ' +
        'Note: only works for articles that are tweet-based (note_tweet). For standalone X Articles, use x_crawl_article instead.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          article_id: {
            type: 'string',
            description: 'Article ID (e.g., "2039029453540532224") or full URL (e.g., "https://x.com/i/article/2039029453540532224")',
          },
        },
        required: ['article_id'],
      },
    },
    {
      name: 'x_crawl_article',
      description:
        'Crawl an X Article page using Chrome to extract its full text content. ' +
        'Works for standalone X Articles (x.com/i/article/...) that the API cannot fetch. ' +
        'Requires x_browser_login first for authentication. Accepts an article URL or ID.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          url: {
            type: 'string',
            description: 'Article URL (e.g., "https://x.com/i/article/2039029453540532224") or bare article ID',
          },
        },
        required: ['url'],
      },
    },
    {
      name: 'x_browser_login',
      description:
        'Open a Chrome window for you to log in to X (Twitter). ' +
        'Required before using x_crawl_article. Login session persists across restarts. ' +
        'Opens a visible browser — complete the login within 2 minutes.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'x_get_saved_tweets',
      description:
        'Search and retrieve tweets previously saved to the local database. ' +
        'No API call is made — returns data from the local SQLite cache.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Text search in tweet content and article text',
          },
          author: {
            type: 'string',
            description: 'Filter by author username (partial match)',
          },
          source: {
            type: 'string',
            description: "Filter by source tool: 'bookmarks' | 'search' | 'get_tweet' | 'user_tweets' | 'thread'",
          },
          limit: {
            type: 'number',
            description: 'Number of results (1-100, default 20)',
            minimum: 1,
            maximum: 100,
          },
          offset: {
            type: 'number',
            description: 'Pagination offset (default 0)',
            minimum: 0,
          },
        },
      },
    },
    {
      name: 'x_get_saved_articles',
      description:
        'Search and retrieve articles previously saved to the local database. ' +
        'Includes both API-fetched note_tweet articles and browser-crawled articles.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Text search in article content',
          },
          author: {
            type: 'string',
            description: 'Filter by author username (partial match)',
          },
          source: {
            type: 'string',
            description: "Filter by source: 'api' | 'crawl'",
          },
          limit: {
            type: 'number',
            description: 'Number of results (1-50, default 10)',
            minimum: 1,
            maximum: 50,
          },
          offset: {
            type: 'number',
            description: 'Pagination offset (default 0)',
            minimum: 0,
          },
        },
      },
    },
    {
      name: 'x_get_saved_users',
      description:
        'Search and retrieve users previously saved to the local database. ' +
        'Users are saved automatically whenever tweets or profiles are fetched.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          query: {
            type: 'string',
            description: 'Text search in username, display name, and bio',
          },
          limit: {
            type: 'number',
            description: 'Number of results (1-100, default 20)',
            minimum: 1,
            maximum: 100,
          },
          offset: {
            type: 'number',
            description: 'Pagination offset (default 0)',
            minimum: 0,
          },
        },
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'x_authorize':
        return await handleAuthorize(args)
      case 'x_get_bookmarks':
        return await handleGetBookmarks(args)
      case 'x_search_tweets':
        return await handleSearchTweets(args)
      case 'x_get_tweet':
        return await handleGetTweet(args)
      case 'x_get_user_tweets':
        return await handleGetUserTweets(args)
      case 'x_get_user':
        return await handleGetUser(args)
      case 'x_get_thread':
        return await handleGetThread(args)
      case 'x_get_article':
        return await handleGetArticle(args)
      case 'x_crawl_article':
        return await handleCrawlArticle(args)
      case 'x_browser_login':
        return await handleBrowserLogin(args)
      case 'x_get_saved_tweets':
        return await handleGetSavedTweets(args)
      case 'x_get_saved_articles':
        return await handleGetSavedArticles(args)
      case 'x_get_saved_users':
        return await handleGetSavedUsers(args)
      default:
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${req.params.name}` }],
          isError: true,
        }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return {
      content: [{ type: 'text' as const, text: `${req.params.name} failed: ${msg}` }],
      isError: true,
    }
  }
})

// Initialize database before connecting transport
try {
  const db = getDb()
  initSchema(db)
  const tweetCount = (db.prepare('SELECT COUNT(*) as n FROM tweets').get() as { n: number }).n
  const articleCount = (db.prepare('SELECT COUNT(*) as n FROM articles').get() as { n: number }).n
  const userCount = (db.prepare('SELECT COUNT(*) as n FROM users').get() as { n: number }).n
  process.stderr.write(
    `x-api: DB ready at ${getDbPath()} (tweets: ${tweetCount}, articles: ${articleCount}, users: ${userCount})\n`
  )
} catch (err) {
  process.stderr.write(`x-api: DB init failed (continuing without persistence): ${err}\n`)
}

// Connect transport
const transport = new StdioServerTransport()
await server.connect(transport)

process.stderr.write('x-api: MCP server started\n')

// Graceful shutdown
let shuttingDown = false
function shutdown(): void {
  if (shuttingDown) return
  shuttingDown = true
  process.stderr.write('x-api: shutting down\n')
  closeBrowser().finally(() => {
    setTimeout(() => process.exit(0), 2000)
  })
}

process.stdin.on('end', shutdown)
process.stdin.on('close', shutdown)
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
process.on('unhandledRejection', (err) => {
  process.stderr.write(`x-api: unhandled rejection: ${err}\n`)
})
process.on('uncaughtException', (err) => {
  process.stderr.write(`x-api: uncaught exception: ${err}\n`)
})
