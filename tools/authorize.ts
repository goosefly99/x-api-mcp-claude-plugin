import { startOAuthFlow, getUserAccessToken } from '../auth.ts'
import { xApiRequest, formatUser, USER_FIELDS } from '../client.ts'
import type { XUser } from '../types.ts'

export async function handleAuthorize(_args: Record<string, unknown>) {
  // Check if already authorized
  const existingToken = await getUserAccessToken()
  if (existingToken) {
    try {
      const { response } = await xApiRequest<XUser>(
        'users/me',
        { 'user.fields': USER_FIELDS },
        'user'
      )
      if (response.data) {
        return {
          content: [{
            type: 'text' as const,
            text: `Already authorized as @${response.data.username} (${response.data.name}).\n\n${formatUser(response.data)}`,
          }],
        }
      }
    } catch {
      // Token invalid, proceed with re-authorization
    }
  }

  const result = await startOAuthFlow()
  return {
    content: [{ type: 'text' as const, text: result }],
  }
}
