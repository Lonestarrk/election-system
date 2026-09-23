import { describe, expect, it } from 'vitest'
import { MOMENTS } from '@/app/architecture/timeline/moments'

/**
 * TIDSLINJENS MOMENT.
 *
 * Tidslinjen på arkitektursidan förklarar valet för den som aldrig hört ordet
 * kryptering, och en sådan läsare kan inte själv kontrollera om liknelsen är
 * rätt. Därför prövas här både att momenten finns, i rätt ordning och med en
 * text, och att texterna säger det liknelsen måste säga för att vara sann
 * (spec 3 och 3.1 i docs/spec/2026-09-22-dubbla-kuvert.md).
 *
 * Animationen är dekorativ och dold för skärmläsare. Det är texten som ska
 * bära hela berättelsen, så det är texten som prövas.
 */

/** Momenten i uppgiftens ordning, med en etikett var. */
const EXPECTED_LABELS = [
  'Valet förbereds',
  'Du loggar in',
  'Du röstar',
  'Du skriver under',
  'I urnan',
  'Du ändrar dig',
  'Röstningen stänger',
  'Kontrollen',
  'Namnen tas bort',
  'Räkningen',
  'Summan öppnas',
  'Resultatet',
  'Efteråt',
]

function moment(label: string) {
  const found = MOMENTS.find((entry) => entry.label === label)
  if (!found) throw new Error(`Momentet "${label}" finns inte.`)
  return found
}

/** Meningar räknas på slutpunkt, frågetecken och utropstecken. */
function sentences(text: string): number {
  return text.split(/[.!?](?:\s|$)/).filter((part) => part.trim().length > 0).length
}

describe('momentlistan', () => {
  it('har alla tretton moment i omröstningens ordning', () => {
    expect(MOMENTS.map((entry) => entry.label)).toEqual(EXPECTED_LABELS)
    expect(MOMENTS.map((entry) => entry.number)).toEqual(EXPECTED_LABELS.map((_, index) => index + 1))
  })

  it('varje moment har en rubrik och en text på en till tre meningar', () => {
    for (const entry of MOMENTS) {
      expect(entry.title.length, `moment ${entry.number} saknar rubrik`).toBeGreaterThan(3)
      expect(entry.text.length, `moment ${entry.number} saknar text`).toBeGreaterThan(40)
      expect(sentences(entry.text), `moment ${entry.number}: ${entry.text}`).toBeGreaterThanOrEqual(1)
      expect(sentences(entry.text), `moment ${entry.number}: ${entry.text}`).toBeLessThanOrEqual(3)
    }
  })

  it('skedena kommer i ordning och går aldrig tillbaka', () => {
    const order = ['Före röstningen', 'Medan röstningen pågår', 'Vid stängningen', 'Räkningen', 'Efteråt']
    const indices = MOMENTS.map((entry) => order.indexOf(entry.stage))

    expect(indices).not.toContain(-1)
    expect([...indices].sort((a, b) => a - b)).toEqual(indices)
    expect(new Set(indices).size).toBe(order.length)
  })

  it('inga fackord, eftersom texten skrivs för den som aldrig hört dem', () => {
    for (const entry of MOMENTS) {
      for (const text of [entry.label, entry.title, entry.text]) {
        expect(text, `moment ${entry.number}`).not.toMatch(
          /krypt|chiff|homomorf|tröskel|hash|merkle|signatur/i,
        )
      }
    }
  })
})

describe('ditt kuvert pekas bara ut så länge namnet finns', () => {
  /**
   * Tidslinjen följer "din röst" med en markering. Efter moment 9, när namnen
   * tas bort, får den inte längre peka ut vilket inre kuvert som är ditt: ett
   * kuvert som animationen pekar ut efter skalningen vore precis den koppling
   * modellen raderar, visad för alla som tittar. Samma princip som "Följ en
   * röst" i livevyn, som glömmer allt från före stängningen.
   */
  it('markeringen släcks i ett enda moment, det då namnen tas bort', () => {
    const releasing = MOMENTS.filter((entry) => entry.yourEnvelope === 'släcks')

    expect(releasing.map((entry) => entry.label)).toEqual(['Namnen tas bort'])
  })

  it('efter det pekar inget moment ut ditt kuvert', () => {
    const released = moment('Namnen tas bort').number
    const after = MOMENTS.filter((entry) => entry.number > released)

    expect(after.length).toBeGreaterThan(0)
    for (const entry of after) {
      expect(entry.yourEnvelope, `moment ${entry.number}`).toBe('ingen')
    }
  })

  it('före det är ditt kuvert utpekat från att det skapas', () => {
    // Kontrasten: markeringen finns, annars vore regeln ovan tom.
    const from = moment('Du röstar').number
    const until = moment('Namnen tas bort').number

    for (const entry of MOMENTS) {
      const expected = entry.number < from ? 'ingen' : entry.number < until ? 'utpekad' : undefined
      if (expected) expect(entry.yourEnvelope, `moment ${entry.number}`).toBe(expected)
    }
  })

  it('texten säger att ingen längre kan peka ut ditt kuvert, inte heller animationen', () => {
    expect(moment('Namnen tas bort').text).toMatch(/ingen peka ut vilket kuvert som är ditt/)
    expect(moment('Namnen tas bort').text).toMatch(/inte heller den här animationen/)
  })
})

describe('liknelsen säger det den måste säga', () => {
  it('de inre kuverten öppnas aldrig ett och ett, bara summan', () => {
    expect(moment('Du ändrar dig').text).toMatch(/slängs utan att öppnas/)
    expect(moment('Kontrollen').text).toMatch(/Inget kuvert öppnas/)
    expect(moment('Räkningen').text).toMatch(/utan att något av dem öppnas/)
    expect(moment('Summan öppnas').text).toMatch(/bara summakuvertet/)
    expect(moment('Summan öppnas').text).toMatch(/De enskilda kuverten förblir stängda/)
  })

  it('summan öppnas bara med två av tre, och ingen kan öppna den ensam', () => {
    expect(moment('Valet förbereds').text).toMatch(/två av tre förtroendepersoner/)
    expect(moment('Valet förbereds').text).toMatch(/Ingen kan öppna låset ensam, inte heller den som driver systemet/)
    expect(moment('Summan öppnas').text).toMatch(/Två av de tre förtroendepersonerna/)
  })

  it('valet läggs i det inre kuvertet på din egen enhet', () => {
    expect(moment('Du röstar').text).toMatch(/din egen/)
    expect(moment('Du röstar').text).toMatch(/innan något skickas/)
  })

  it('namnet står på det yttre kuvertet med avsikt, så att rösten kan bytas', () => {
    expect(moment('I urnan').text).toMatch(/med avsikt/)
    expect(moment('I urnan').text).toMatch(/ändrar dig/)
  })

  it('skärmen visar rösten men kan inte bevisa den', () => {
    expect(moment('Du ändrar dig').text).toMatch(/visar din nuvarande röst/)
    expect(moment('Du ändrar dig').text).toMatch(/kan inte bevisa/)
  })

  it('vid skalningen sorteras de inre kuverten, så att ordningen inte avslöjar något', () => {
    expect(moment('Namnen tas bort').text).toMatch(/sorteras/)
    expect(moment('Namnen tas bort').text).toMatch(/ordningen inte avslöjar vem som röstade när/)
  })

  it('efteråt ser du att du har röstat, inte vad, och ingen annan heller', () => {
    expect(moment('Efteråt').text).toMatch(/att du har röstat, men inte vad/)
    expect(moment('Efteråt').text).toMatch(/Ingen annan kan se din röst/)
  })

  it('beviset överdriver inte vad allmänheten kan räkna om', () => {
    // Spec 3.1: att summan består av just de giltiga rösterna går inte att
    // räkna om utifrån, utan vilar på kontrollen före stängningen.
    expect(moment('Resultatet').text).toMatch(/kontrollera att summan öppnades rätt/)
    expect(moment('Resultatet').text).toMatch(/går inte att räkna om utifrån/)
  })
})
