import { beforeEach, describe, expect, it } from 'vitest'
import {
  AdmissionQueueFull,
  admissionStats,
  MAX_CONCURRENT,
  MAX_QUEUED,
  resetAdmissionQueue,
  runAdmitted,
} from '@/lib/admission-queue'

/**
 * Antagningskön bär tre egenskaper, och de går sönder på olika sätt:
 *
 *   SAMTIDIGHETSGRÄNSEN skyddar minnet. Brister den tar valdagen ned servern
 *   genom att tusen legitimeringar allokerar 32 GB.
 *
 *   AVLÄMNINGEN skyddar genomströmningen. Plockas ingen ur kön när en plats
 *   blir fri står systemet still med full kö och lediga platser — det värsta
 *   utfallet, eftersom det ser ut som överbelastning men är en bugg.
 *
 *   RÄTTVISAN skyddar väljaren. Brister den kan någon som kom senare gå före,
 *   och en uppskattad väntetid blir meningslös.
 *
 * Testerna nedan använder grindar som går att öppna en i taget. Det är enda
 * sättet att se avlämningen: med `setTimeout` avslutas uppgifterna i en klump,
 * och då går det inte att skilja "plockade en" från "plockade alla".
 */

type Gate = { promise: Promise<void>; open: () => void }

function makeGate(): Gate {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** Låter köns promises schemaläggas färdigt. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Startar `count` uppgifter som blockerar på var sin grind.
 *
 * Returnerar när de första har hunnit ta sina platser och resten står i kön.
 */
async function startBlocked(count: number) {
  const gates = Array.from({ length: count }, makeGate)
  const started: number[] = []
  const finished: number[] = []

  const running = gates.map((gate, index) =>
    runAdmitted(async () => {
      started.push(index)
      await gate.promise
      finished.push(index)
    }),
  )

  await settle()

  return { gates, started, finished, running }
}

beforeEach(() => {
  resetAdmissionQueue()
})

describe('samtidighetsgränsen', () => {
  it('släpper igenom högst MAX_CONCURRENT samtidigt', async () => {
    let samtidiga = 0
    let toppNoterad = 0

    await Promise.all(
      Array.from({ length: 50 }, () =>
        runAdmitted(async () => {
          samtidiga += 1
          toppNoterad = Math.max(toppNoterad, samtidiga)
          await settle()
          samtidiga -= 1
        }),
      ),
    )

    expect(toppNoterad).toBe(MAX_CONCURRENT)
  })

  it('alla femtio blir ändå körda', async () => {
    let körda = 0

    await Promise.all(
      Array.from({ length: 50 }, () =>
        runAdmitted(async () => {
          await settle()
          körda += 1
        }),
      ),
    )

    // Ingen avvisas när kön rymmer dem. Det är hela skillnaden mot en
    // hastighetsgräns, som hade svarat 429 på överskottet.
    expect(körda).toBe(50)
  })
})

describe('fler anslutningar än gränsen', () => {
  it('de första tar platserna och överskottet ställs i kön', async () => {
    const { gates, started, running } = await startBlocked(MAX_CONCURRENT + 40)

    expect(started).toHaveLength(MAX_CONCURRENT)
    expect(admissionStats()).toMatchObject({ active: MAX_CONCURRENT, waiting: 40 })

    gates.forEach((gate) => gate.open())
    await Promise.all(running)
  })

  it('avvisar först när även kön är full, och inte en enda tidigare', async () => {
    const gate = makeGate()

    // Exakt så många som ryms: platserna plus varje köplats.
    const admitted = Array.from({ length: MAX_CONCURRENT + MAX_QUEUED }, () =>
      runAdmitted(() => gate.promise),
    )
    await settle()

    expect(admissionStats()).toMatchObject({
      active: MAX_CONCURRENT,
      waiting: MAX_QUEUED,
    })

    // Nästa femtio får inte plats.
    const avvisade = await Promise.allSettled(
      Array.from({ length: 50 }, () => runAdmitted(async () => 'ok')),
    )

    expect(
      avvisade.every(
        (utfall) => utfall.status === 'rejected' && utfall.reason instanceof AdmissionQueueFull,
      ),
    ).toBe(true)

    /**
     * DE AVVISADE FÅR INTE RUBBA KÖN.
     *
     * Avvisningen sker innan platsräknaren rörs, så den ska varken ta en plats
     * eller frigöra någon annans. Vore den felplacerad — inuti try-blocket, så
     * att `finally` körde `release()` — skulle femtio avvisningar dra ned
     * `active` till noll och släppa in alla 308 samtidigt. Alltså precis den
     * minnestopp kön finns för att förhindra.
     */
    expect(admissionStats()).toMatchObject({
      active: MAX_CONCURRENT,
      waiting: MAX_QUEUED,
    })

    gate.open()
    await Promise.all(admitted)

    // Alla 308 som kom in blev körda; ingen tappades.
    expect(admissionStats()).toMatchObject({ active: 0, waiting: 0 })

    // Kapaciteten är återställd: samma anrop som nyss avvisades går nu igenom.
    await expect(runAdmitted(async () => 'ok')).resolves.toBe('ok')
  })
})

describe('avlämning när antalet går under gränsen', () => {
  it('en frigjord plats plockar exakt en ur kön', async () => {
    const { gates, started, finished, running } = await startBlocked(MAX_CONCURRENT + 4)

    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(admissionStats()).toMatchObject({ active: MAX_CONCURRENT, waiting: 4 })

    // Öppna en enda grind.
    gates[0]!.open()
    await settle()

    expect(finished).toEqual([0])

    // Den nionde har startat — och bara den. Hade release() plockat flera
    // skulle samtidigheten överskrida taket; hade den plockat noll skulle
    // systemet stå still med ledig plats och full kö.
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
    expect(admissionStats()).toMatchObject({ active: MAX_CONCURRENT, waiting: 3 })

    gates.forEach((gate) => gate.open())
    await Promise.all(running)
  })

  it('tre frigjorda platser plockar tre, en per plats', async () => {
    const { gates, started, running } = await startBlocked(MAX_CONCURRENT + 10)

    gates[0]!.open()
    gates[1]!.open()
    gates[2]!.open()
    await settle()

    expect(started).toHaveLength(MAX_CONCURRENT + 3)
    expect(admissionStats()).toMatchObject({ active: MAX_CONCURRENT, waiting: 7 })

    gates.forEach((gate) => gate.open())
    await Promise.all(running)
  })

  it('platserna hålls fyllda medan kön töms', async () => {
    /**
     * Kärnan i kapacitetshanteringen: så länge någon väntar ska alla platser
     * vara i bruk. En kö som låter platser stå tomma är sämre än ingen kö,
     * eftersom väntetiden då växer utan att minnet sparas.
     */
    const { gates, running } = await startBlocked(MAX_CONCURRENT + 20)

    for (let i = 0; i < 20; i += 1) {
      gates[i]!.open()
      await settle()

      // Full beläggning så länge kön inte är tom.
      expect(admissionStats().active).toBe(MAX_CONCURRENT)
      expect(admissionStats().waiting).toBe(19 - i)
    }

    gates.forEach((gate) => gate.open())
    await Promise.all(running)

    expect(admissionStats()).toMatchObject({ active: 0, waiting: 0 })
  })

  it('tömmer en full kö helt när grindarna öppnas', async () => {
    const { gates, finished, running } = await startBlocked(MAX_CONCURRENT + MAX_QUEUED)

    gates.forEach((gate) => gate.open())
    await Promise.all(running)

    expect(finished).toHaveLength(MAX_CONCURRENT + MAX_QUEUED)
    expect(admissionStats()).toMatchObject({ active: 0, waiting: 0 })
  })
})

describe('rättvisan', () => {
  it('plockar ur kön i den ordning uppgifterna anlände', async () => {
    /**
     * En vanlig semafor släpper igenom väntande i den ordning deras promises
     * råkar schemaläggas. Här får den som kom först gå först — en väljare ska
     * inte kunna bli omkörd av någon som anlände senare. Det är också vad som
     * gör den uppskattade väntetiden meningsfull att visa.
     */
    const { gates, started, running } = await startBlocked(MAX_CONCURRENT + 30)

    // Öppna grindarna i omvänd ordning. Ordningen uppgifterna AVSLUTAS i får
    // inte påverka ordningen de PLOCKAS i.
    for (let i = gates.length - 1; i >= 0; i -= 1) {
      gates[i]!.open()
      await settle()
    }

    await Promise.all(running)

    expect(started).toEqual(Array.from({ length: MAX_CONCURRENT + 30 }, (_, i) => i))
  })
})

describe('platser läcker inte', () => {
  it('en kastande uppgift frigör sin plats', async () => {
    /**
     * DET FARLIGASTE FELET.
     *
     * Frigörs inte platsen i `finally` minskar kapaciteten permanent för varje
     * fel. Efter åtta fel vore systemet låst, och ingenting hade synts i
     * loggarna — bara att legitimeringar slutat gå igenom.
     */
    for (let försök = 0; försök < 20; försök += 1) {
      await expect(
        runAdmitted(async () => {
          throw new Error('simulerat fel')
        }),
      ).rejects.toThrow('simulerat fel')
    }

    expect(admissionStats()).toMatchObject({ active: 0, waiting: 0 })

    // Kapaciteten ska vara orörd efteråt.
    const { started, gates, running } = await startBlocked(MAX_CONCURRENT + 5)
    expect(started).toHaveLength(MAX_CONCURRENT)

    gates.forEach((gate) => gate.open())
    await Promise.all(running)
  })

  it('ett fel hos en väntande stoppar inte de efterföljande', async () => {
    const lyckade: number[] = []

    await Promise.allSettled(
      Array.from({ length: 30 }, (_, index) =>
        runAdmitted(async () => {
          await settle()
          if (index % 3 === 0) throw new Error('vart tredje felar')
          lyckade.push(index)
        }),
      ),
    )

    // Tjugo av trettio lyckas; felen stör inte avlämningen.
    expect(lyckade).toHaveLength(20)
    expect(admissionStats()).toMatchObject({ active: 0, waiting: 0 })
  })
})

describe('väntetiden som visas för väljaren', () => {
  it('växer med kön och landar på sekunder, inte minuter', async () => {
    const { gates, running } = await startBlocked(100)

    const stats = admissionStats()

    expect(stats.active).toBe(MAX_CONCURRENT)
    expect(stats.waiting).toBe(100 - MAX_CONCURRENT)
    // Hundra väntande delat på åtta platser à 80 ms ≈ en sekund.
    expect(stats.estimatedWaitSeconds).toBeGreaterThan(0)
    expect(stats.estimatedWaitSeconds).toBeLessThan(5)

    gates.forEach((gate) => gate.open())
    await Promise.all(running)

    expect(admissionStats().estimatedWaitSeconds).toBe(0)
  })
})
