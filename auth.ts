import { readFileSync, writeFileSync, unlinkSync } from 'fs'
import { createServer, type Server as HttpServer } from 'http'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { randomBytes, createHash } from 'crypto'
import { execFile } from 'child_process'
import type { XTokens } from './types.ts'

const TOKEN_PATH = join(homedir(), '.x-tokens.json')
const OAUTH2_AUTHORIZE_URL = 'https://twitter.com/i/oauth2/authorize'
const OAUTH2_TOKEN_URL = 'https://api.x.com/2/oauth2/token'
const BEARER_TOKEN_URL = 'https://api.x.com/oauth2/token'
const SCOPES = 'bookmark.read tweet.read users.read offline.access'
const CALLBACK_PORT = 3000
const REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`

let cachedBearerToken: string | null = null

function getConsumerKeys(): { key: string; secret: string } {
  const key = process.env.X_API_CONSUMER_KEY
  const secret = process.env.X_API_SECRET_KEY
  if (!key || !secret) {
    throw new Error('X_API_CONSUMER_KEY and X_API_SECRET_KEY must be set')
  }
  return { key, secret }
}

function getOAuth2ClientId(): string {
  const clientId = process.env.X_O_AUTH_2_0_CLIENT_ID
  if (!clientId) {
    throw new Error('X_O_AUTH_2_0_CLIENT_ID must be set')
  }
  return clientId
}

/** Get an app-only bearer token (cached after first call) */
export async function getBearerToken(): Promise<string> {
  if (cachedBearerToken) return cachedBearerToken

  const { key, secret } = getConsumerKeys()
  const credentials = Buffer.from(
    `${encodeURIComponent(key)}:${encodeURIComponent(secret)}`
  ).toString('base64')

  const res = await fetch(BEARER_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${credentials}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Failed to get bearer token (${res.status}): ${text}`)
  }

  const data = (await res.json()) as { access_token: string }
  cachedBearerToken = data.access_token
  return cachedBearerToken
}

/** Load stored OAuth 2.0 user tokens from disk */
export function loadTokens(): XTokens | null {
  try {
    const raw = readFileSync(TOKEN_PATH, 'utf-8')
    return JSON.parse(raw) as XTokens
  } catch {
    return null
  }
}

/** Save OAuth 2.0 user tokens to disk */
export function saveTokens(tokens: XTokens): void {
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), { mode: 0o600 })
}

/** Refresh an expired access token using the refresh token */
export async function refreshAccessToken(
  refreshToken: string
): Promise<XTokens> {
  const clientId = getOAuth2ClientId()

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  })

  const res = await fetch(OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token refresh failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type: string
    scope?: string
  }

  const tokens: XTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? refreshToken,
    expires_at: data.expires_in
      ? Math.floor(Date.now() / 1000) + data.expires_in
      : undefined,
    token_type: data.token_type,
    scope: data.scope,
  }

  saveTokens(tokens)
  return tokens
}

/** Get a valid user access token, auto-refreshing if needed */
export async function getUserAccessToken(): Promise<string | null> {
  const tokens = loadTokens()
  if (!tokens) return null

  const now = Math.floor(Date.now() / 1000)
  const isExpired = tokens.expires_at && tokens.expires_at - now < 60

  if (isExpired && tokens.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(tokens.refresh_token)
      return refreshed.access_token
    } catch {
      return null
    }
  }

  return tokens.access_token
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url')
}

// Track the active callback server so we can clean it up between attempts
let activeCallbackServer: ReturnType<typeof createServer> | null = null

function cleanupCallbackServer(): void {
  if (activeCallbackServer) {
    try { activeCallbackServer.close() } catch { /* ignore */ }
    activeCallbackServer = null
  }
}

/**
 * Start the OAuth 2.0 PKCE authorization flow.
 * Opens the user's browser, waits for the callback, exchanges the code,
 * and stores the tokens. Returns a status message.
 */
export async function startOAuthFlow(): Promise<string> {
  const clientId = getOAuth2ClientId()

  // Clean up any leftover server from a previous interrupted attempt
  cleanupCallbackServer()

  // Generate PKCE pair
  const codeVerifier = base64url(randomBytes(96)) // 128 chars
  const codeChallenge = base64url(
    createHash('sha256').update(codeVerifier).digest()
  )
  const state = randomBytes(32).toString('hex')

  let resolveCallback: (code: string) => void
  let rejectCallback: (err: Error) => void
  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve
    rejectCallback = reject
  })

  const server = createServer((req, res) => {
    const url = new URL(req.url!, `http://127.0.0.1`)

    if (url.pathname !== '/callback') {
      res.writeHead(404).end('Not found')
      return
    }

    const error = url.searchParams.get('error')
    if (error) {
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(
        '<html><body><h2>Authorization failed.</h2><p>You can close this tab.</p></body></html>'
      )
      rejectCallback(new Error(`OAuth error: ${error}`))
      return
    }

    if (url.searchParams.get('state') !== state) {
      res.writeHead(400).end('State mismatch')
      rejectCallback(new Error('OAuth state mismatch'))
      return
    }

    const code = url.searchParams.get('code')
    if (!code) {
      res.writeHead(400).end('Missing code')
      rejectCallback(new Error('No authorization code received'))
      return
    }

    res.writeHead(200, { 'Content-Type': 'text/html' }).end(
      '<html><body><h2>Authorization successful!</h2><p>You can close this tab and return to Claude.</p></body></html>'
    )
    resolveCallback(code)
  })

  activeCallbackServer = server

  // Listen on the fixed callback port
  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${CALLBACK_PORT} is already in use. Try again in a moment.`))
      } else {
        reject(err)
      }
    })
    server.listen(CALLBACK_PORT, '127.0.0.1', resolve)
  })

  // Build authorization URL
  const authUrl = new URL(OAUTH2_AUTHORIZE_URL)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('client_id', clientId)
  authUrl.searchParams.set('redirect_uri', REDIRECT_URI)
  authUrl.searchParams.set('scope', SCOPES)
  authUrl.searchParams.set('state', state)
  authUrl.searchParams.set('code_challenge', codeChallenge)
  authUrl.searchParams.set('code_challenge_method', 'S256')

  const authUrlStr = authUrl.toString()
  process.stderr.write(`x-api: Auth URL: ${authUrlStr}\n`)

  // Open browser via temp HTML redirect file (avoids cmd & escaping issues)
  openBrowser(authUrlStr)

  // Wait for callback with timeout
  const timeout = setTimeout(() => {
    cleanupCallbackServer()
    rejectCallback(new Error('OAuth authorization timed out after 120 seconds'))
  }, 120_000)

  let code: string
  try {
    code = await codePromise
  } finally {
    clearTimeout(timeout)
    cleanupCallbackServer()
  }

  // Exchange authorization code for tokens
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    code_verifier: codeVerifier,
  })

  const res = await fetch(OAUTH2_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed (${res.status}): ${text}`)
  }

  const data = (await res.json()) as {
    access_token: string
    refresh_token?: string
    expires_in?: number
    token_type: string
    scope?: string
  }

  const tokens: XTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_in
      ? Math.floor(Date.now() / 1000) + data.expires_in
      : undefined,
    token_type: data.token_type,
    scope: data.scope,
  }

  saveTokens(tokens)
  return 'Successfully authorized! Tokens stored. You can now use x_get_bookmarks and other user-context tools.'
}

/** Open a URL in the default browser using a temp HTML redirect (avoids shell escaping issues) */
function openBrowser(url: string): void {
  try {
    const tempFile = join(tmpdir(), `x-auth-${Date.now()}.html`)
    writeFileSync(
      tempFile,
      `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${url}"><title>Redirecting...</title></head><body><p>Redirecting to X authorization...</p><p><a href="${url}">Click here if not redirected</a></p></body></html>`
    )
    // Open the temp HTML file -- cmd /c start handles file paths without escaping issues
    execFile('cmd.exe', ['/c', 'start', '', tempFile])
    // Clean up after a delay
    setTimeout(() => {
      try { unlinkSync(tempFile) } catch { /* ignore */ }
    }, 10_000)
  } catch (err) {
    process.stderr.write(
      `x-api: Could not open browser automatically. Navigate to:\n${url}\n`
    )
  }
}
