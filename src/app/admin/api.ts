/**
 * Anropen adminsidan gör mot servern (uppgift 12c).
 *
 * Alla går som POST med CSRF-token ur cookien `valcsrf`, som resten av
 * adminrutterna kräver. Svaret läses alltid som JSON om det går. En rutt som
 * kraschar kan svara med något annat, och sidan ska då visa ett besked i
 * stället för att själv krascha.
 */

export function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)valcsrf=([^;]+)/)
  return match ? decodeURIComponent(match[1]!) : ''
}

export type ApiResult = {
  ok: boolean
  httpStatus: number
  data: Record<string, unknown>
}

export async function post(path: string, body: unknown): Promise<ApiResult> {
  try {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() },
      body: JSON.stringify(body),
    })

    let data: Record<string, unknown> = {}
    try {
      data = (await response.json()) as Record<string, unknown>
    } catch {
      // Inget JSON i svaret. Beskedet nedan säger det.
    }
    return { ok: response.ok, httpStatus: response.status, data }
  } catch {
    return { ok: false, httpStatus: 0, data: {} }
  }
}

/**
 * Serverns eget besked ur ett svar: `message` i en rutts utfall, eller felet i
 * `error.message`. Finns inget, sägs det rakt ut, utan att gissa en orsak.
 */
export function messageOf(result: ApiResult, fallback: string): string {
  const direct = result.data.message
  if (typeof direct === 'string' && direct !== '') return direct

  const error = result.data.error
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }

  if (result.httpStatus === 0) {
    return 'Servern svarade inte. Läs om omröstningens fas innan du försöker igen.'
  }
  return `${fallback} (svar ${result.httpStatus} utan besked)`
}
