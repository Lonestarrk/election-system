/**
 * Notismodulens publika yta.
 *
 * Modulen vet att någon vill bli meddelad — aldrig vem. Prenumerationer lagras
 * utan koppling till identitet, och notisen innehåller bara omröstningens namn
 * och id.
 */

export {
  countSubscriptions,
  isPushConfigured,
  notifyNewElection,
  publicVapidKey,
  removeSubscription,
  saveSubscription,
} from './push.service'

export type { NotificationOutcome, PushSubscriptionInput } from './push.service'
