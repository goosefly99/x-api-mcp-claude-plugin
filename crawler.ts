import { chromium, type BrowserContext, type Page } from 'playwright-core'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync, existsSync } from 'node:fs'

const PROFILE_DIR = join(homedir(), '.x-api-mcp', 'chrome-profile')

let browserContext: BrowserContext | null = null
let contextHeadless: boolean | null = null

// ── Browser lifecycle ────────────────────────────────────────────

async function getContext(headless: boolean): Promise<BrowserContext> {
  // Close existing context if headless mode changed
  if (browserContext && contextHeadless !== headless) {
    await closeBrowser()
  }

  if (browserContext) {
    try {
      // Verify still alive
      await browserContext.pages()
      return browserContext
    } catch {
      browserContext = null
    }
  }

  if (!existsSync(PROFILE_DIR)) {
    mkdirSync(PROFILE_DIR, { recursive: true })
  }

  browserContext = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    channel: 'chrome',
    viewport: { width: 1280, height: 900 },
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
    ],
  })
  contextHeadless = headless

  return browserContext
}

export async function closeBrowser(): Promise<void> {
  if (browserContext) {
    try { await browserContext.close() } catch { /* ignore */ }
    browserContext = null
    contextHeadless = null
  }
}

// ── Browser login ────────────────────────────────────────────────

/**
 * Open a visible Chrome window at x.com/login for the user to authenticate.
 * Waits up to 2 minutes for login completion, then saves the session.
 */
export async function browserLogin(): Promise<{ success: boolean; message: string }> {
  const ctx = await getContext(false) // visible so user can interact
  const page = await ctx.newPage()

  try {
    await page.goto('https://x.com/login', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })

    // Already logged in?
    if (page.url().includes('/home')) {
      await page.close()
      return {
        success: true,
        message: 'Already logged in. Browser session is valid.',
      }
    }

    // Wait for the user to complete login
    try {
      await page.waitForURL('**/home**', { timeout: 120_000 })
      await page.close()
      // Switch to headless for future crawl calls
      await closeBrowser()
      return {
        success: true,
        message: 'Login successful! Session saved. You can now use x_crawl_article.',
      }
    } catch {
      await page.close()
      await closeBrowser()
      return {
        success: false,
        message: 'Login timed out (2 minutes). Run x_browser_login again.',
      }
    }
  } catch (err) {
    await page.close().catch(() => {})
    await closeBrowser()
    throw err
  }
}

// ── Article crawling ─────────────────────────────────────────────

export interface CrawlResult {
  content: string
  author?: string
  loginRequired: boolean
}

/**
 * Navigate to an X article URL and extract its text content.
 * Uses a persistent Chrome profile so login state is preserved.
 */
export async function crawlArticle(url: string): Promise<CrawlResult> {
  const ctx = await getContext(true) // headless
  const page = await ctx.newPage()

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 })
    // X is a React SPA — wait for content to render
    await page.waitForTimeout(4_000)

    // Detect login wall
    const currentUrl = page.url()
    if (currentUrl.includes('/login') || currentUrl.includes('/i/flow/login')) {
      return { content: '', loginRequired: true }
    }

    const bodyText = await page.locator('body').innerText().catch(() => '')
    if (bodyText.length < 200 && /sign\s*in|log\s*in/i.test(bodyText)) {
      return { content: '', loginRequired: true }
    }

    // Extract content
    const content = await extractContent(page)
    const author = await page
      .locator('[data-testid="User-Name"]')
      .first()
      .innerText()
      .catch(() => undefined)

    return { content, author: author || undefined, loginRequired: false }
  } finally {
    await page.close()
  }
}

// ── Content extraction ───────────────────────────────────────────

async function extractContent(page: Page): Promise<string> {
  // Strategy 1: tweetText blocks (long-form tweets rendered as articles)
  const tweetTexts = await page
    .locator('[data-testid="tweetText"]')
    .allInnerTexts()
    .catch(() => [] as string[])

  if (tweetTexts.length > 0 && tweetTexts.join('').length > 100) {
    return tweetTexts.join('\n\n')
  }

  // Strategy 2: article element
  const articleText = await page
    .locator('article')
    .first()
    .innerText()
    .catch(() => '')

  if (articleText.length > 100) {
    return cleanExtractedText(articleText)
  }

  // Strategy 3: main content, excluding nav/sidebar
  const mainText = await page
    .locator('main')
    .first()
    .innerText()
    .catch(() => '')

  if (mainText.length > 100) {
    return cleanExtractedText(mainText)
  }

  // Strategy 4: collect long text blocks across the page
  const collected = await page.evaluate(() => {
    const seen = new Set<string>()
    const parts: string[] = []
    for (const el of document.querySelectorAll('div[dir="auto"], p, span')) {
      const text = (el as HTMLElement).innerText?.trim()
      if (text && text.length > 50 && !seen.has(text)) {
        seen.add(text)
        parts.push(text)
      }
    }
    return parts.join('\n\n')
  }).catch(() => '')

  if (collected.length > 100) return collected

  // Last resort: full page text
  return await page.locator('body').innerText().catch(() => 'Could not extract content')
}

/** Strip common X UI noise from extracted text. */
function cleanExtractedText(text: string): string {
  const uiNoise = new Set([
    'Follow', 'Following', 'Post', 'Reply', 'Repost',
    'Like', 'More', 'Share', 'Bookmark', 'Copy link',
    'Send via Direct Message', 'Add to Highlights',
  ])

  const lines = text.split('\n').filter(line => {
    const t = line.trim()
    if (!t) return true               // keep blank lines for paragraph breaks
    if (uiNoise.has(t)) return false   // strip UI buttons
    if (/^\d+$/.test(t)) return false  // standalone numbers (engagement counts)
    return true
  })

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
