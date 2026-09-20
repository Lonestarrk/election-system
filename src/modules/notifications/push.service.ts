import webpush from 'web-push'
import { truncateToDay } from '@/lib/time'
import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { votersDb } from '@/modules/eligibility/db'

/**
 * Push-notiser om nya omröstningar.
 *
 * INGEN PRENUMERATION ÄR KOPPLAD TILL EN IDENTITET.
 *
 * Tabellen `push_subscription` har ingen foreign key till `voter_status` och
 * inget identitetshash. Det är inte en förenkling utan ett krav: en
 * push-endpoint är i praktiken en enhetsidentifierare, och skulle den ligga
 * bredvid ett identitetshash avslöjar en databasdump vilken telefon som hör
 * till vilken person. En ny avanonymiseringsyta, införd för en
 * bekvämlighetsfunktion.
 *
 * Konsekvensen är att notiser går till alla prenumeranter, även icke
 * röstberättigade. Det är ett accepterat pris — meddelandet säger bara att en
 * omröstning öppnat, vilket är offentlig information ändå.
 *
 * VARFÖR TABELLEN LIGGER I RÖSTLÄNGDSDATABASEN
 *
 * Den måste ligga någonstans, och röstdatabasen är uteslutet: en
 * enhetsidentifierare i samma databas som rösterna vore betydligt värre. I
 * röstlängden ligger den som en fristående tabell utan relation till någon
 * väljare.
 *
 * VAD NOTISEN INNEHÅLLER
 *
 * Omröstningens namn och id, ingenting annat. Aldrig något om mottagaren,
 * aldrig något om röster. Nyttolasten krypteras dessutom mot just den enheten
 * med dess egna nycklar, så push-tjänsten (Google, Apple, Mozilla) ser bara
 * en ogenomtränglig blob.
 */

export type PushSubscriptionInput = {
  endpoint: string
  keys: { p256dh: string; auth: string }
}

export type NotificationOutcome = {
  sent: number
  failed: number
  /** Sant när VAPID-nycklar saknas och utskick därför är avstängt. */
  disabled?: boolean
}

let configured = false

/**
 * Konfigurerar VAPID en gång per process.
 *
 * Returnerar false om nycklar saknas. Systemet ska gå att köra utan dem —
 * notiser är en bekvämlighet, och en POC utan VAPID-nycklar ska inte vägra
 * starta.
 */
function ensureConfigured(): boolean {
  const keys = env.vapid
  if (!keys) return false

  if (!configured) {
    webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey)
    configured = true
  }

  return true
}

export function isPushConfigured(): boolean {
  return env.vapid !== null
}

export function publicVapidKey(): string | null {
  return env.vapid?.publicKey ?? null
}

/**
 * Sparar en prenumeration.
 *
 * Idempotent på endpoint: samma enhet som prenumererar igen ska inte ge två
 * rader och därmed två notiser.
 */
export async function saveSubscription(input: PushSubscriptionInput): Promise<void> {
  await votersDb.pushSubscription.upsert({
    where: { endpoint: input.endpoint },
    update: { p256dh: input.keys.p256dh, auth: input.keys.auth },
    create: {
      endpoint: input.endpoint,
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
      // Dygnsupplösning, av samma skäl som votedAt. En exakt
      // prenumerationstidpunkt skulle kunna korreleras mot en
      // legitimeringstidpunkt om samma person gör båda strax efter varandra.
      createdAt: truncateToDay(new Date()),
    },
  })
}

export async function removeSubscription(endpoint: string): Promise<void> {
  await votersDb.pushSubscription.deleteMany({ where: { endpoint } })
}

export async function countSubscriptions(): Promise<number> {
  return votersDb.pushSubscription.count()
}

/**
 * Skickar en notis om en ny omröstning till samtliga prenumeranter.
 *
 * DÖDA PRENUMERATIONER STÄDAS BORT. En endpoint som svarar 404 eller 410 hör
 * till en enhet som avinstallerat appen eller återkallat tillståndet. Att låta
 * dem ligga kvar vore att spara enhetsidentifierare för enheter som sagt nej —
 * och listan skulle växa utan gräns.
 */
export async function notifyNewElection(election: {
  electionId: string
  name: string
}): Promise<NotificationOutcome> {
  if (!ensureConfigured()) {
    logger.warn('VAPID-nycklar saknas — ingen notis skickades')
    return { sent: 0, failed: 0, disabled: true }
  }

  const subscriptions = await votersDb.pushSubscription.findMany({
    select: { endpoint: true, p256dh: true, auth: true },
  })

  const payload = JSON.stringify({
    title: 'Ny omröstning öppen',
    body: `${election.name} är nu öppen för röstning.`,
    electionId: election.electionId,
  })

  let sent = 0
  let failed = 0
  const dead: string[] = []

  await Promise.all(
    subscriptions.map(async (subscription) => {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
        )
        sent += 1
      } catch (error) {
        failed += 1

        const statusCode =
          typeof error === 'object' && error !== null && 'statusCode' in error
            ? Number((error as { statusCode: unknown }).statusCode)
            : 0

        if (statusCode === 404 || statusCode === 410) {
          dead.push(subscription.endpoint)
        }
      }
    }),
  )

  if (dead.length > 0) {
    await votersDb.pushSubscription.deleteMany({ where: { endpoint: { in: dead } } })
  }

  // Notera att varken endpoints eller antal mottagare loggas. Ett antal
  // tillsammans med en tidsstämpel är en signal om hur många enheter som är
  // aktiva just då, och den sortens sidoinformation hör inte hemma i loggen.
  return { sent, failed }
}
