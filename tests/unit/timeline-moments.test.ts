import { describe, expect, it } from 'vitest'
import { MOMENTS } from '@/app/architecture/timeline/moments'
import { vaultClaimProblems } from '../vault-claims'

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

describe('valvet i tidslinjen', () => {
  /**
   * Uppgift 11g. I Azure ligger systemets hemligheter i Key Vault, och pepparn
   * där används vid inloggningen, när intyget från BankID knyts till väljaren
   * och låses in i kuvertet, och i kontrollen före stängningen. Varje moment
   * där valvet används säger det, och två moment säger uttryckligen vad valvet
   * inte gör: att det inte tar bort kopplingen (9) och att det inte har någon
   * del av nyckeln till summan (11).
   *
   * `inScene` avgör om valvet lyser i scenen. Scenen läser fältet och ingenting
   * annat, så att texten och bilden inte kan gå isär.
   */
  const withNote = MOMENTS.filter((entry) => entry.vault !== null)

  it('valvet nämns i de moment där det används, och i de två där det uttryckligen inte gör något', () => {
    expect(withNote.map((entry) => entry.label)).toEqual([
      'Valet förbereds',
      'Du loggar in',
      'Du skriver under',
      'Du ändrar dig',
      'Kontrollen',
      'Namnen tas bort',
      'Summan öppnas',
      'Efteråt',
    ])
  })

  it('valvet lyser i scenen bara där dess hemlighet används', () => {
    const lit = MOMENTS.filter((entry) => entry.vault?.inScene === true).map((entry) => entry.label)
    expect(lit).toEqual([
      'Valet förbereds',
      'Du loggar in',
      'Du skriver under',
      'Du ändrar dig',
      'Kontrollen',
      'Efteråt',
    ])
    // Där valvet inte gör något står det nedtonat, också när texten nämner det.
    expect(moment('Namnen tas bort').vault?.inScene).toBe(false)
    expect(moment('Summan öppnas').vault?.inScene).toBe(false)
  })

  it('varje anteckning är en till tre meningar på vardagsspråk', () => {
    for (const entry of withNote) {
      const text = entry.vault!.text
      expect(text.length, `moment ${entry.number}`).toBeGreaterThan(40)
      expect(sentences(text), `moment ${entry.number}: ${text}`).toBeGreaterThanOrEqual(1)
      expect(sentences(text), `moment ${entry.number}: ${text}`).toBeLessThanOrEqual(3)
      expect(text, `moment ${entry.number}`).not.toMatch(/krypt|chiff|homomorf|tröskel|hash|merkle|signatur/i)
      // Sidan kallar det valvet. Produktnamnet står på Tekniska detaljer.
      expect(text, `moment ${entry.number}`).not.toMatch(/Key Vault|Azure/)
    }
  })

  it('valet förbereds: hemligheterna i valvet, och nyckelns delar inte där', () => {
    const text = moment('Valet förbereds').vault!.text
    expect(text).toMatch(/hemligheter förvaras i ett valv/)
    expect(text).toMatch(/fingeravtryck/)
    expect(text).toMatch(/Låsets nyckel finns inte i valvet, varken hel eller i delar/)
    // Inte att förtroendepersonerna HAR delarna (granskningen av 11g, M6): de
    // ligger i röstdatabasen, var och en låst med sin förtroendepersons lösenord.
    expect(text).toMatch(/varje del är inlåst med sin förtroendepersons eget lösenord/)
    expect(text).not.toMatch(/delarna har förtroendepersonerna/)
  })

  it('inloggningen: ett fingeravtryck med hemligheten, och röstlängden har inte numret', () => {
    const text = moment('Du loggar in').vault!.text
    expect(text).toMatch(/fingeravtryck med en hemlighet ur valvet/)
    expect(text).toMatch(/I röstlängden står fingeravtrycket, aldrig själva numret/)
    // Inte att röstlängden BARA har fingeravtrycket: raden bär också
    // folkbokföringskommunen, se begränsningen municipality-beside-identity-hash.
    expect(text).not.toMatch(/bara fingeravtrycket/)
  })

  it('underskriften: intyget prövas och låses in med samma hemlighet', () => {
    // Spec 4.6 punkt 2 och 3: personnumret i lövet hashas med samma peppar som
    // röstlängden, och kedjan krypteras under en nyckel ur pepparn.
    const text = moment('Du skriver under').vault!.text
    expect(text).toMatch(/intyg med ditt namn och personnummer/)
    expect(text).toMatch(/för att se att det är ditt/)
    expect(text).toMatch(/låser sedan in intyget i det yttre kuvertet/)
    expect(text).toMatch(/samma hemlighet ur valvet/)
    expect(moment('Du ändrar dig').vault!.text).toMatch(/samma hemlighet ur valvet/)
  })

  it('kontrollen: hemligheten låser upp intygen, men valvet har ingen nyckel till de inre kuverten', () => {
    const text = moment('Kontrollen').vault!.text
    expect(text).toMatch(/låser upp intygen/)
    expect(text).toMatch(/medan namnen finns kvar/)
    expect(text).toMatch(/De inre kuverten förblir låsta/)
    expect(text).toMatch(/har valvet ingen nyckel/)
  })

  it('namnen tas bort: det är raderingen och inte valvet, och en kopia öppnas fortfarande', () => {
    const text = moment('Namnen tas bort').vault!.text
    expect(text).toMatch(/De inlåsta intygen slängs med de yttre kuverten/)
    expect(text).toMatch(/Det är raderingen som tar bort kopplingen ur urnan, inte valvet/)
    expect(text).toMatch(/den visar aldrig vad någon har röstat på/)
    expect(text).toMatch(/kopia av urnan från före stängningen låser den däremot fortfarande upp namnen/)
    // Inte att hemligheten efteråt BARA kan visa vem som röstat: med den och
    // röstlängden går också folkbokföringskommunen att läsa av, se begränsningen
    // municipality-beside-identity-hash. Det som alltid gäller är att den aldrig
    // visar vad någon röstat på.
    expect(text).not.toMatch(/bara visa/)
  })

  it('summan öppnas: valvet har ingen del av nyckeln', () => {
    const text = moment('Summan öppnas').vault!.text
    expect(text).toMatch(/Valvet har ingen del av nyckeln till summan/)
    expect(text).toMatch(/förtroendepersonernas egna lösenord/)
    expect(text).toMatch(/inte heller i valvet/)
  })

  it('efteråt: fingeravtrycket hittar dig, och röstlängden säger inte vad', () => {
    expect(moment('Efteråt').vault!.text).toMatch(/fingeravtrycket/)
    expect(moment('Efteråt').vault!.text).toMatch(/inte vad/)
  })
})

describe('valvet håller aldrig förtroendepersonernas nycklar och tar aldrig bort kopplingen', () => {
  /**
   * De två liknelsekraven som uppgift 11g lade till de åtta från 11f. Reglerna
   * står i tests/vault-claims.ts och prövas här mot varje text i varje moment,
   * och i tests/security/architecture-page.test.ts mot huvudsidans filer.
   */
  it('ingen text i något moment bryter mot reglerna', () => {
    for (const entry of MOMENTS) {
      const text = `${entry.title}. ${entry.text} ${entry.vault?.text ?? ''}`
      expect(vaultClaimProblems(text), `moment ${entry.number}`).toEqual([])
    }
  })

  it('ingen anteckning om valvet lovar att något blir omöjligt', () => {
    for (const entry of MOMENTS) {
      expect(entry.vault?.text ?? '', `moment ${entry.number}`).not.toMatch(/omöjlig|anonym/i)
    }
  })

  it('reglerna hittar de formuleringar de finns till för', () => {
    // Kontrasten. Utan den kunde en regel som aldrig slår till få testet ovan
    // att passera för evigt.
    const flagged = [
      'Valvet förvarar förtroendepersonernas nycklar.',
      'Nyckelns delar ligger i valvet.',
      'Delarna av nyckeln förvaras i valvet, väl skyddade.',
      'Tack vare valvet går kopplingen inte att återskapa.',
      'Valvet gör kopplingen omöjlig.',
      'Med valvet blir rösten anonym.',
    ]
    for (const sentence of flagged) {
      expect(vaultClaimProblems(sentence).length, sentence).toBe(1)
    }

    const allowed = [
      'Låsets nyckel finns inte i valvet, varken hel eller i delar: delarna har förtroendepersonerna.',
      'Valvet har ingen del av nyckeln till summan.',
      'Det är raderingen som tar bort kopplingen ur urnan, inte valvet.',
      'Förtroendepersonerna lämnar var sin del av nyckeln.',
    ]
    for (const sentence of allowed) {
      expect(vaultClaimProblems(sentence), sentence).toEqual([])
    }
  })

  it('reglerna hittar granskningens naturliga felformuleringar', () => {
    /**
     * Granskningen av 11g skrev fjorton meningar som en författare kunde tänkas
     * skriva, och tre som ser negerade ut men påstår motsatsen. Med de första
     * reglerna passerade tolv av de fjorton och alla tre. Ingen av dem får
     * passera igen. Reglerna fångar fortfarande bara formuleringar som liknar
     * dessa; se huvudet i tests/vault-claims.ts för vad de inte kan fånga.
     */
    const naturalMistakes = [
      // Valvet håller nycklarna eller delarna.
      'Valvet håller andelarna till summan.',
      'I valvet ligger förtroendepersonernas lösenord.',
      'Valvet förvarar delarna till låset.',
      'Valvet vaktar låsets tre delar.',
      'Nyckeln till låset förvaras i valvet.',
      'Valvet har nyckeln till de inre kuverten.',
      'Delarna finns i valvet men inte i databasen.',
      'Förtroendepersonernas delar finns inte i databasen utan i valvet.',
      // Valvet tar bort kopplingen.
      'Valvet ser till att ingen kan se vem som röstade på vad.',
      'Tack vare valvet går det inte att se vilket kuvert som är ditt.',
      'Valvet skyddar din valhemlighet.',
      'Efter stängningen raderar valvet namnen.',
      'Valvet raderar sambandet mellan dig och din röst.',
      'Valvet skyddar mot att någon kopplar ihop dig med din röst, inte valvet ensamt men nästan.',
    ]
    const seeminglyNegated = [
      'Valvet har inte bara systemets hemligheter utan också förtroendepersonernas delar av nyckeln.',
      'Det är inte valvet utan raderingen som gör kopplingen omöjlig, men valvet gör den omöjlig i kopiorna.',
      'Valvet gör kopplingen omöjlig, inte valvet ensamt.',
    ]
    for (const sentence of [...naturalMistakes, ...seeminglyNegated]) {
      expect(vaultClaimProblems(sentence).length, sentence).toBeGreaterThan(0)
    }

    // Och sidans egna sätt att säga det rätt passerar, också när de nämner
    // samma saker: delar, lösenord, namnen och kopplingen.
    const pageSentences = [
      'Nyckelns tre delar finns inte i valvet.',
      'Delarna låses upp med förtroendepersonernas egna lösenord, och de finns inte heller i valvet.',
      'Det är inte valvet utan raderingen som tar bort kopplingen.',
      'Delarna finns inte i valvet utan i databasen.',
      'Den som får läsa valvet behöver då bara komma åt urnan med namn, eller en kopia av den, för att få namnen.',
      'Hemligheten i valvet gör fingeravtryck av personnummer, och med dem och röstlängden går det att se om en viss person står i röstlängden.',
      'Samma valv har också en huvudnyckel till båda urnorna, och systemet kan läsa den.',
    ]
    for (const sentence of pageSentences) {
      expect(vaultClaimProblems(sentence), sentence).toEqual([])
    }
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
