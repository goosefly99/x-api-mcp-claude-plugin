# X API MCP Server — Feature Additions

## Context

This MCP server (`x-api-mcp/`) wraps X API v2 for use with Claude Code. It has 6 tools: `x_authorize`, `x_get_bookmarks`, `x_search_tweets`, `x_get_tweet`, `x_get_user_tweets`, `x_get_user`.

We use it to catalog bookmarked trading strategy posts. Many bookmarks link to **X Articles** (long-form posts), **quote other tweets**, or are **thread starters** — and we currently can't retrieve any of that content. The server also omits media metadata and author bios from tweet-returning tools.

This document specifies the required changes. All changes target X API v2 (`https://api.x.com/2`).

---

## 1. Enhance query parameters on ALL tweet-fetching tools

**Files to modify:** `client.ts` (if shared params exist), `tools/bookmarks.ts`, `tools/search.ts`, `tools/tweets.ts`

Every tool that fetches tweets currently uses:

```
tweet.fields=created_at,author_id,public_metrics,entities
user.fields=description,public_metrics,profile_image_url,verified,created_at
expansions=author_id
```

Update ALL of them to use:

```
tweet.fields=created_at,author_id,public_metrics,entities,note_tweet,conversation_id,referenced_tweets,attachments
user.fields=description,public_metrics,profile_image_url,verified,created_at
expansions=author_id,referenced_tweets.id,referenced_tweets.id.author_id,attachments.media_keys
media.fields=type,url,preview_image_url,alt_text,duration_ms,variants
```

**What each addition does:**

| Field | Purpose |
|---|---|
| `note_tweet` | Returns full text of X Articles / long-form posts (these are tweets where `text` is truncated and the real content is in `note_tweet.text`) |
| `conversation_id` | Identifies which conversation/thread a tweet belongs to — needed for the new `x_get_thread` tool |
| `referenced_tweets` | Array indicating if the tweet is a quote, reply, or retweet of another tweet, with the referenced tweet's ID |
| `attachments` | Contains `media_keys` array linking to media objects |
| `referenced_tweets.id` (expansion) | Includes the full content of referenced tweets in `includes.tweets` |
| `referenced_tweets.id.author_id` (expansion) | Includes author data for referenced tweets in `includes.users` |
| `attachments.media_keys` (expansion) | Includes media objects (type, URLs, dimensions) in `includes.media` |
| `media.fields` | Specifies which media metadata to return |

If the server has a shared function for building query params (check `client.ts`), update it there. Otherwise update each tool individually.

---

## 2. Update type definitions

**File to modify:** `types.ts`

Add the following interfaces and update `XTweet`:

```typescript
interface XNoteTweet {
  text: string
  entities?: {
    urls?: Array<{
      start: number
      end: number
      url: string
      expanded_url: string
      display_url: string
      title?: string
      description?: string
    }>
    mentions?: Array<{
      start: number
      end: number
      username: string
    }>
    hashtags?: Array<{
      start: number
      end: number
      tag: string
    }>
  }
}

interface XReferencedTweet {
  type: 'quoted' | 'replied_to' | 'retweeted'
  id: string
}

interface XMedia {
  media_key: string
  type: 'photo' | 'video' | 'animated_gif'
  url?: string
  preview_image_url?: string
  alt_text?: string
  duration_ms?: number
  variants?: Array<{
    bit_rate?: number
    content_type: string
    url: string
  }>
}
```

Update `XTweet` to include:

```typescript
interface XTweet {
  // ... existing fields ...
  note_tweet?: XNoteTweet
  conversation_id?: string
  referenced_tweets?: XReferencedTweet[]
  attachments?: {
    media_keys?: string[]
  }
}
```

Update `XApiResponse` to include media in includes:

```typescript
interface XApiResponse<T> {
  data?: T
  includes?: {
    users?: XUser[]
    tweets?: XTweet[]
    media?: XMedia[]
  }
  meta?: { /* ... existing ... */ }
  errors?: XApiError[]
}
```

---

## 3. Update formatted output for all tweet-returning tools

**Files to modify:** `client.ts` (if a shared formatter exists), or each tool file

The formatted text output for tweets currently shows: author, date, text, metrics, links.

Update the formatter to also display:

### Article / Note content
If `tweet.note_tweet?.text` exists, display it as the main content instead of `tweet.text`. Label it clearly:

```
--- Tweet 123456 ---
Author: @handle (Display Name)
Date: 4/2/2026, 3:45:00 PM
[Article]

Full article text here from note_tweet.text...

  Likes: 500 | RT: 50 | Replies: 20
```

### Referenced tweets (quotes, replies)
If `tweet.referenced_tweets` exists, show the type and look up the full content from `includes.tweets`:

```
  Quoted Tweet (123456) by @otheruser:
    Original tweet text here...
```

### Media metadata
If `includes.media` exists and matches the tweet's `attachments.media_keys`, show:

```
Media:
  [video] https://video-url.mp4
  [photo] https://photo-url.jpg
```

### Author bio
Include the author's `description` field (already available from `user.fields=description` but not currently displayed):

```
Author: @handle (Display Name)
Bio: Author's bio/description text
```

### Conversation ID
Show conversation_id when present:

```
Thread: 123456789 (conversation_id)
```

---

## 4. New tool: `x_get_thread`

**File to create:** `tools/thread.ts`
**File to modify:** `server.ts` (register the new tool)

### Purpose
Retrieve a full conversation thread given any tweet ID in the thread.

### Parameters
- `tweet_id` (string, required): Any tweet ID in the thread
- `max_results` (number, optional): Max replies to fetch, 10-100, default 50

### Implementation

1. Fetch the given tweet with `conversation_id` in tweet.fields (use the same enhanced params from section 1)
2. Extract `conversation_id` from the response
3. Use `tweets/search/recent` with query `conversation_id:{conversation_id}` to get all tweets in the thread
4. Include the same enhanced tweet.fields, expansions, and media.fields
5. Sort results chronologically (by `created_at`)
6. Format output showing the full thread in order, with each tweet's author, text (or note_tweet.text), and metrics

### Auth
Use **app context** (bearer token) — same as `x_search_tweets`.

### Important notes
- The `tweets/search/recent` endpoint only searches the last 7 days. If the thread is older, the tool should return what it can and note the limitation.
- The root tweet (conversation starter) has `conversation_id === id`. Fetch it separately if it's not included in search results.
- Include referenced tweets (quotes) inline in the output.

### Schema

```typescript
{
  name: 'x_get_thread',
  description: 'Get a full conversation thread given any tweet ID in the thread. Returns all tweets in the conversation sorted chronologically. Note: only searches last 7 days of tweets.',
  inputSchema: {
    type: 'object',
    properties: {
      tweet_id: {
        type: 'string',
        description: 'Any tweet ID from the thread'
      },
      max_results: {
        type: 'number',
        description: 'Maximum replies to fetch (10-100, default 50)',
        minimum: 10,
        maximum: 100
      }
    },
    required: ['tweet_id']
  }
}
```

---

## 5. New tool: `x_get_article`

**File to create:** `tools/article.ts`
**File to modify:** `server.ts` (register the new tool)

### Purpose
Retrieve the full content of an X Article given its URL or ID.

### Parameters
- `article_id` (string, required): The article ID or full URL (e.g., `2039029453540532224` or `https://x.com/i/article/2039029453540532224`)

### Implementation

1. Parse the article ID from the input (strip URL prefix if full URL provided — extract the numeric ID from `x.com/i/article/{id}`)
2. Fetch the tweet using `tweets/{article_id}` endpoint with the enhanced tweet.fields including `note_tweet`
3. The `note_tweet.text` field should contain the full article content
4. If `note_tweet` is not present in the response, the ID may not correspond to an article tweet — return an appropriate message
5. Include author info, article text, entities (URLs, mentions, hashtags from note_tweet.entities), and engagement metrics

### Auth
Use **app context** (bearer token).

### Formatted output

```
--- Article by @handle (Display Name) ---
Date: 4/2/2026
Bio: Author's bio

[Article Content]
Full article text from note_tweet.text...

  Likes: 500 | RT: 50 | Replies: 20

Links in article:
  example.com → https://example.com/page
```

### Schema

```typescript
{
  name: 'x_get_article',
  description: 'Get the full content of an X Article (long-form post). Accepts an article ID or full x.com/i/article/ URL.',
  inputSchema: {
    type: 'object',
    properties: {
      article_id: {
        type: 'string',
        description: 'Article ID (e.g., "2039029453540532224") or full URL (e.g., "https://x.com/i/article/2039029453540532224")'
      }
    },
    required: ['article_id']
  }
}
```

### Important caveat
X Article IDs may or may not be standard tweet IDs. If fetching via `tweets/{id}` returns a 404 or empty result, investigate whether X Articles require a different endpoint. In that case, log the issue clearly in the tool's error response so we know to adjust.

---

## 6. Enhance `x_get_bookmarks` output

**File to modify:** `tools/bookmarks.ts`

In addition to the shared parameter enhancements (section 1), the bookmarks tool should:

1. **Include author bio** — the `description` field is already requested in `user.fields` but not displayed. Add it to the formatted output after the author line.

2. **Inline referenced tweet content** — when a bookmark quotes another tweet, show the quoted tweet's text (from `includes.tweets`) in the output.

3. **Show article content inline** — if a bookmarked tweet has `note_tweet.text`, display the full article text instead of just the URL.

4. **Show media type and URLs** — for each media attachment, show its type and best-quality URL.

5. **Show conversation_id** — so we can identify threads and use `x_get_thread` to fetch the rest.

---

## 7. Enhance `x_get_user` output

**File to modify:** `tools/users.ts`

The `x_get_user` tool already returns profile data. Additionally request and include:

- `user.fields` should include `url,location,pinned_tweet_id` in addition to existing fields
- When `pinned_tweet_id` is present, fetch the pinned tweet content and include it in output

This helps identify what a trading account is primarily about.

---

## 8. Update OAuth scopes if needed

**File to modify:** `auth.ts`

Current scopes: `bookmark.read tweet.read users.read offline.access`

These should be sufficient for all new functionality since the new tools use app-context auth (bearer token) or existing user-context endpoints. No scope changes needed unless testing reveals otherwise.

---

## Verification checklist

After implementing, verify each of these works:

1. `x_get_bookmarks` — returns article content (note_tweet.text) for article tweets, shows author bios, shows quoted tweet content, shows media metadata
2. `x_get_tweet` — returns note_tweet, referenced_tweets, media, conversation_id
3. `x_get_thread` — returns a full ordered conversation given any tweet ID
4. `x_get_article` — returns full article text given an article URL like `x.com/i/article/2039029453540532224`
5. `x_search_tweets` — returns enhanced fields
6. `x_get_user_tweets` — returns enhanced fields
7. `x_get_user` — returns location, url, pinned tweet content

Test with these specific IDs from our bookmarks:
- Article tweet: `2037604599398322682` (adiix_official, 4.5K likes — should have note_tweet content)
- Article tweet: `2038654832819535895` (bored2boar — should have note_tweet content)
- Quote tweet: `2039776473687494784` (adiix_official quoting `2037604599398322682`)
- Video tweet: `2039746395100377447` (Lummox_eth — should show media metadata)
- Thread candidate: `2039344379824144642` (AiWithSaira "10 prompts" — likely a thread)
