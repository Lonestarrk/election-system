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

  it('texten säger att det inte längre går att se i urnan, och nämner kopiorna', () => {
    /**
     * Inte att INGEN kan peka ut kuvertet: den som kopierade urnan med namnen
     * före stängningen, till exempel via en säkerhetskopia, kan det
     * fortfarande. Påståendet gäller urnan och animationen, och texten
     * hänvisar till svagheterna.
     */
    const text = moment('Namnen tas bort').text
    expect(text).toMatch(/inte längre att se i urnan vilket kuvert som är ditt/)
    expect(text).toMatch(/inte heller i den här animationen/)
    expect(text).toMatch(/kopierade urnan medan namnen fanns kvar kan fortfarande veta det/)
    expect(text).toMatch(/svagheterna/)
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

  it('summan öppnas bara med två av tre, och ingen av dem kan öppna den ensam', () => {
    const prepared = moment('Valet förbereds').text
    expect(prepared).toMatch(/två av tre förtroendepersoner har lämnat var sin del av nyckeln/)
    expect(prepared).toMatch(/Ingen av dem kan öppna låset ensam/)
    expect(moment('Summan öppnas').text).toMatch(/Två av de tre förtroendepersonerna/)
  })

  it('svagheten med låset nämns i samma andetag som att ingen kan öppna det ensam', () => {
    // Spec 4.5 och 10: när låset tillverkas finns hela nyckeln ett ögonblick
    // hos den som gör det i ordning, alltså den som driver systemet.
    const prepared = moment('Valet förbereds').text
    expect(prepared).toMatch(/låset görs i ordning av den som driver systemet/)
    expect(prepared).toMatch(/hela nyckeln ett ögonblick på ett ställe/)
  })

  it('delarna av nyckeln lämnas var för sig, och summan går upp först när två finns', () => {
    // Spec 6.2: förtroendepersonerna lämnar sina bidrag var för sig.
    const opened = moment('Summan öppnas').text
    expect(opened).toMatch(/lämnar var sin del av nyckeln, en i taget/)
    expect(opened).toMatch(/Först när två delar finns/)
  })

  it('enheten raderar sina uppgifter när sidan ser att röstningen stängt, och annars bevisar de ingenting', () => {
    // Spec 3.1 punkt 4.
    const closing = moment('Röstningen stänger').text
    expect(closing).toMatch(/Så snart sidan ser att röstningen har stängt/)
    expect(closing).toMatch(/Öppnar du aldrig sidan igen ligger uppgifterna kvar, men de bevisar ingenting/)
  })

  it('ett fel i kontrollen öppnar inte röstningen igen', () => {
    expect(moment('Kontrollen').text).toMatch(/röstningen förblir stängd/)
    expect(moment('Kontrollen').text).not.toMatch(/stoppas stängningen/)
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

describe('liknelsen lovar inte mer än specen', () => {
  /**
   * Tre formuleringar som stod i en tidigare version, och som alla lovade mer
   * än specen medger. Ingen av dem får komma tillbaka i något moment.
   */
  const texts = MOMENTS.map((entry) => ({ number: entry.number, text: `${entry.title} ${entry.text}` }))

  it('ingen påstår att ingen kan peka ut ditt kuvert', () => {
    // Den som kopierade urnan före stängningen kan det.
    for (const { number, text } of texts) {
      expect(text, `moment ${number}`).not.toMatch(/ingen (kan )?peka ut|kan ingen peka ut/i)
    }
  })

  it('ingen påstår att inte heller den som driver systemet kan öppna låset', () => {
    // När låset tillverkas finns hela nyckeln hos den som gör det i ordning.
    for (const { number, text } of texts) {
      expect(text, `moment ${number}`).not.toMatch(/inte heller den som driver systemet/i)
      expect(text, `moment ${number}`).not.toMatch(/\bIngen kan öppna\b/)
    }
  })

  it('ingen påstår att förtroendepersonerna gör något samtidigt', () => {
    // De lämnar sina delar var för sig (spec 6.2).
    for (const { number, text } of texts) {
      expect(text, `moment ${number}`).not.toMatch(/samtidigt/i)
    }
  })
})
