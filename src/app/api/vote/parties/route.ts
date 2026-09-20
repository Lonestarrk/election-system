import { jsonResponse } from '@/lib/http'
import { listParties } from '@/modules/anonymous-vote'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/vote/parties
 *
 * Partilistan. Öppen — vilka partier som ställer upp i ett val är offentlig
 * information, och att kräva legitimering för att se den skulle bara göra det
 * svårare att granska systemet.
 */
export async function GET() {
  const parties = await listParties()
  return jsonResponse({ parties })
}
