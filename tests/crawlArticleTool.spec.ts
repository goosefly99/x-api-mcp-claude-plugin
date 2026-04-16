/**
 * TDD spec for X6 — x_crawl_article demoted to manual-override with stderr note.
 *
 * Verifies:
 *   1. Stderr note is emitted before the crawl executes.
 *   2. Stderr note contains "manual override".
 *   3. Stderr note is still emitted even if the crawler throws.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── module mocks ─────────────────────────────────────────────────────────────

vi.mock('../crawler.ts', () => ({
  crawlArticle: vi.fn(),
  browserLogin: vi.fn(),
}))

vi.mock('../db/connection.ts', () => ({
  getDb: vi.fn(),
}))

vi.mock('../db/repos/articles.ts', () => ({
  upsertArticle: vi.fn(),
}))

// ── imports (after vi.mock hoisting) ────────────────────────────────────────

import { crawlArticle } from '../crawler.ts'
import { handleCrawlArticle } from '../tools/crawl.ts'

// ── tests ────────────────────────────────────────────────────────────────────

describe('handleCrawlArticle (manual-override stderr note)', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
  })

  it('emits a stderr note containing "manual override" before crawling', async () => {
    const mockCrawl = vi.mocked(crawlArticle)
    mockCrawl.mockResolvedValue({
      content: 'Article content here that is long enough to pass the 50-char check.',
      author: 'testauthor',
      loginRequired: false,
    })

    await handleCrawlArticle({ url: 'https://x.com/i/article/123456789' })

    expect(stderrSpy).toHaveBeenCalled()
    const calls = stderrSpy.mock.calls.map(c => String(c[0]))
    const noteCall = calls.find(s => s.includes('manual override'))
    expect(noteCall).toBeDefined()
    expect(noteCall).toContain('manual override')

    // The note must have been emitted before crawlArticle was called
    const stderrCallOrder = stderrSpy.mock.invocationCallOrder[0]
    const crawlCallOrder = mockCrawl.mock.invocationCallOrder[0]
    expect(stderrCallOrder).toBeLessThan(crawlCallOrder)
  })

  it('emits the stderr note even when the crawler throws', async () => {
    const mockCrawl = vi.mocked(crawlArticle)
    mockCrawl.mockRejectedValue(new Error('crawler exploded'))

    await expect(
      handleCrawlArticle({ url: 'https://x.com/i/article/123456789' }),
    ).rejects.toThrow('crawler exploded')

    expect(stderrSpy).toHaveBeenCalled()
    const calls = stderrSpy.mock.calls.map(c => String(c[0]))
    const noteCall = calls.find(s => s.includes('manual override'))
    expect(noteCall).toBeDefined()
  })

  it('emits the stderr note for a bare article ID input', async () => {
    const mockCrawl = vi.mocked(crawlArticle)
    mockCrawl.mockResolvedValue({
      content: 'Bare ID article content long enough to pass the content length check here.',
      author: null,
      loginRequired: false,
    })

    await handleCrawlArticle({ url: '123456789' })

    const calls = stderrSpy.mock.calls.map(c => String(c[0]))
    const noteCall = calls.find(s => s.includes('manual override'))
    expect(noteCall).toBeDefined()
  })
})
