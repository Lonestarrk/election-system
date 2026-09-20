/**
 * SERVICE WORKER
 *
 * Tar emot push-notiser om nya omröstningar och visar dem på enheten.
 *
 * VAD DEN MEDVETET INTE GÖR
 *
 * Den cachar ingenting. En service worker som cachar sidor vore frestande —
 * det är hela poängen med dem i vanliga appar — men här skulle det betyda att
 * delar av röstningsgränssnittet levereras från enhetens disk i stället för
 * från servern. Två skäl gör det olämpligt:
 *
 *   1. En cachad valsedel kan vara inaktuell. Väljaren skulle kunna se partier
 *      som inte längre står på valsedeln.
 *   2. Kryptokoden som blindar röstintyget måste komma från servern varje
 *      gång, så att den går att granska mot det som faktiskt levereras. En
 *      cachad kopia gör det svårare att avgöra vilken version som kördes.
 *
 * Den lagrar inte heller något om notiserna. Ingen historik, ingen IndexedDB,
 * inget i localStorage. Notisen visas och glöms.
 */

self.addEventListener('install', (event) => {
  // Aktivera direkt i stället för att vänta på att öppna flikar stängs.
  // Notiser ska fungera från första besöket.
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  /**
   * Nyttolasten är krypterad mot just den här enhetens nycklar. Push-tjänsten
   * — Google, Apple, Mozilla — har transporterat en ogenomtränglig blob och
   * vet inte vad den innehåller.
   */
  let payload = { title: 'Ny omröstning', body: 'En omröstning har öppnat.', electionId: null }

  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    // Trasig nyttolast ska inte tysta notisen helt — väljaren får det
    // generiska meddelandet i stället för ingenting.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/icon.svg',
      badge: '/icon.svg',
      // Nya notiser om samma sak ersätter varandra i stället för att staplas.
      tag: 'ny-omrostning',
      data: { electionId: payload.electionId },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()

  const target = '/'

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // Återanvänd en öppen flik om det finns en. En ny flik per notis är både
      // irriterande och ett sätt att av misstag lämna en påbörjad röstning.
      for (const client of clients) {
        if ('focus' in client) return client.focus()
      }

      return self.clients.openWindow(target)
    }),
  )
})
