import type { CSSProperties, ReactNode } from 'react'
import type { Moment } from './moments'

/**
 * SCENEN I TIDSLINJEN.
 *
 * En och samma bild genom hela omröstningen: din enhet, urnan med namn, urnan
 * utan namn, låset och de tre förtroendepersonerna står alltid på samma plats,
 * så att läsaren känner igen scenen från moment till moment. Det som inte
 * deltar i ett moment tonas ned i stället för att försvinna.
 *
 * HUR ANIMATIONEN ÄR BYGGD
 *
 * Varje element ritas i momentets SLUTLÄGE. Ett element som ändras i momentet
 * får en animation som går FRÅN läget efter förra momentet TILL slutläget, och
 * den fyller bakåt (`animation-fill-mode: both`), så att elementet står i sitt
 * startläge tills det är dess tur. Tre saker följer av det:
 *
 *   – Utan animation syns slutläget direkt. Det gäller vid
 *     `prefers-reduced-motion` och när sidan laddas, eftersom animationerna
 *     bara finns i en mediefråga för den som inte bett om mindre rörelse, och
 *     bara när tidslinjen säger att momentet ska spelas.
 *   – Varje moment börjar där förra slutade, var läsaren än kom ifrån.
 *   – Ett nytt klick monterar om scenen, och animationen spelas igen.
 *
 * Stilarna och nyckelbilderna står i src/app/globals.css under "Tidslinjen".
 * Positionen sätts med `transform` som attribut på en yttre grupp, och
 * animationen med CSS på en inre. En CSS-transform på samma element skulle
 * skriva över attributet.
 *
 * VAD SCENEN ALDRIG GÖR
 *
 * Den öppnar aldrig ett inre kuvert, inte ens i en animation. Det enda som
 * öppnas är summakuvertet, i moment 11, och de enskilda kuverten står kvar i
 * bild med sina lås.
 *
 * Den pekar inte ut ditt kuvert efter moment 9. Markeringen ritas bara när
 * momentets `yourEnvelope` säger det. I moment 9 släcks den i samma ögonblick
 * som namnen försvinner, och kuverten i urnan utan namn är nya element som
 * aldrig har burit markeringen. De samlas i en punkt och sprids därifrån, så
 * att inte ens den som följer rörelsen med blicken kan säga vilket som var
 * ditt, och de står i ett annat mönster än i urnan med namn, så att inte heller
 * en stillbild antyder det. Allt som pekar ut ditt kuvert bär `data-yours`, så
 * att testerna kan kontrollera att inget sådant syns efteråt.
 *
 * Scenen är dekorativ och dold för skärmläsare. Texten i moments.ts bär hela
 * berättelsen.
 */

// ---------------------------------------------------------------------------
// Platserna i scenen, i SVG-enheter. Bredden är 320 så att en telefon i
// 390 px ritar ungefär en enhet per pixel.
// ---------------------------------------------------------------------------

const VIEW_BOX = '0 0 320 212'

const PHONE = { x: 12, y: 10, w: 54, h: 96 }
const SCREEN = { x: 17, y: 20, w: 44, h: 76 }
const TRUSTEE_X = [214, 250, 286] as const
/** Nyckelns ring, där förtroendepersonen håller den. Spetsen sitter 14 under. */
const KEY_REST = TRUSTEE_X.map((cx) => ({ x: cx + 14, y: 26 }))
const KEYHOLE_X = [215, 224, 233] as const
const KEYHOLE_Y = 101.5
const CARD = { x: 200, y: 73, w: 98, h: 48 }
const NAMED = { x: 76, y: 142, w: 100, h: 50 }
const ANON = { x: 196, y: 142, w: 100, h: 50 }
/** Där de inre kuverten samlas när de sorteras. */
const SORTER = { x: 186, y: 160 }
/** Papperskorgens öppning, dit det som slängs försvinner. */
const BIN_MOUTH = { x: 22, y: 146 }
/** Dit kopiorna av kuverten går när de räknas ihop. */
const SUM_TARGET = { x: 262, y: 97 }

const OUTER = { w: 26, h: 18 }
const INNER = { w: 22, h: 15 }

/** Platserna för de yttre kuverten i urnan med namn. Ditt ligger på plats 2. */
const NAMED_SLOTS = [
  { x: 82, y: 149 },
  { x: 113, y: 149 },
  { x: 144, y: 149 },
  { x: 97, y: 169 },
  { x: 128, y: 169 },
] as const
const YOUR_SLOT = NAMED_SLOTS[1]
const OTHER_SLOTS = NAMED_SLOTS.filter((slot) => slot !== YOUR_SLOT)

/**
 * Platserna i urnan utan namn. Inget av dem är ditt, och inget pekas ut.
 *
 * MÖNSTRET ÄR ETT ANNAT ÄN I URNAN MED NAMN, två över och tre under i stället
 * för tre över och två under. Med samma mönster hade stillbilderna, till
 * exempel vid prefers-reduced-motion där sorteringen inte syns, antytt att
 * kuvertet mitt i översta raden fortfarande var ditt. Det är samma princip som
 * markeringen, fast med plats i stället för färg.
 */
const ANON_SLOTS = [
  { x: 220, y: 150 },
  { x: 250, y: 150 },
  { x: 205, y: 170 },
  { x: 235, y: 170 },
  { x: 265, y: 170 },
] as const

/** Kuverten på telefonens skärm är samma kuvert, en och en halv gång större. */
const PHONE_SCALE = 1.5
const PHONE_OUTER = { x: 19.5, y: 45 }
const PHONE_INNER = { x: 22.5, y: 47.5 }

/** Summakuvertets innehåll när det öppnats: A, B och C, fem röster. */
const RESULT = [
  { option: 'A', count: 1 },
  { option: 'B', count: 2 },
  { option: 'C', count: 2 },
] as const

// ---------------------------------------------------------------------------
// Vilka delar av scenen som deltar i varje moment
// ---------------------------------------------------------------------------

type Zone = 'phone' | 'trustees' | 'lock' | 'named' | 'anon' | 'bin'

const ACTIVE: Record<number, readonly Zone[]> = {
  1: ['trustees', 'lock'],
  2: ['phone'],
  3: ['phone'],
  4: ['phone'],
  5: ['phone', 'named'],
  6: ['phone', 'named', 'bin'],
  7: ['phone', 'named'],
  8: ['named'],
  9: ['named', 'anon', 'bin'],
  10: ['anon', 'lock'],
  11: ['trustees', 'lock', 'anon'],
  12: ['lock'],
  13: ['phone', 'anon', 'lock'],
}

function isActive(zone: Zone, n: number): boolean {
  return (ACTIVE[n] ?? []).includes(zone)
}

/** Nedtonad eller inte, med en övergång om läget skiftat sedan förra momentet. */
function zoneClass(zone: Zone, n: number): string {
  const now = isActive(zone, n)
  const before = n > 1 ? isActive(zone, n - 1) : now
  return ['tl-zone', now ? '' : 'tl-dimmed', now === before ? '' : now ? 'tl-undim' : 'tl-dim']
    .filter(Boolean)
    .join(' ')
}

// ---------------------------------------------------------------------------
// Animationerna
// ---------------------------------------------------------------------------

type Kind =
  | 'move' /* från (dx, dy) och skalan s till viloläget */
  | 'appear' /* tonas in */
  | 'pop' /* växer fram från mitten */
  | 'vanish' /* tonas ut, och syns inte i viloläget */
  | 'leave' /* glider mot (dx, dy) medan det tonas ut */
  | 'away' /* glider mot (dx, dy) och tonas ut först vid slutet */
  | 'scatter' /* kommer ut från (dx, dy) och glider till viloläget */
  | 'sweep' /* sveper från (dx, dy) till viloläget och försvinner */
  | 'grow' /* växer ut från vänster */

type AnimProps = {
  kind: Kind
  /** När animationen börjar, i sekunder från klicket. */
  at?: number
  /** Hur länge den pågår. */
  dur?: number
  dx?: number
  dy?: number
  s?: number
  /** Elementet pekar ut ditt kuvert. Se kommentaren överst. */
  yours?: YoursPart | false
  /** Ett yttre kuvert med namn, på väg bort i moment 9. */
  name?: boolean
  children: ReactNode
}

/**
 * En animerad grupp. Tiderna räknas från klicket, också för en grupp inuti en
 * annan: alla animationer i scenen startar när den monteras.
 */
function A({ kind, at = 0, dur = 0.4, dx = 0, dy = 0, s = 1, yours, name, children }: AnimProps) {
  const style = {
    '--d': `${at}s`,
    '--t': `${dur}s`,
    '--dx': `${dx}px`,
    '--dy': `${dy}px`,
    '--s': s,
  } as CSSProperties

  return (
    <g
      className={`tl-a tl-${kind}`}
      style={style}
      data-yours={yours || undefined}
      data-name={name ? '' : undefined}
    >
      {children}
    </g>
  )
}

/** Animerar bara i det moment där det som visas ändras. Annars står det still. */
function AnimateIf({ when, children, ...anim }: AnimProps & { when: boolean }) {
  return when ? <A {...anim}>{children}</A> : <>{children}</>
}

function At({ x, y, scale, children }: { x: number; y: number; scale?: number; children: ReactNode }) {
  return <g transform={`translate(${x} ${y})${scale ? ` scale(${scale})` : ''}`}>{children}</g>
}

// ---------------------------------------------------------------------------
// Figurerna, ritade kring origo
// ---------------------------------------------------------------------------

type Mark = 'none' | 'yours' | 'release'

/**
 * Vad i scenen som pekar ut ditt kuvert: kuvertet självt, namnet på det och
 * lappen "Din röst". Blir attributet data-yours, som e2e-testerna läser.
 */
type YoursPart = 'envelope' | 'name' | 'tag'

/**
 * Ett kuvert. Det yttre bär en namnlapp, i samma orange som identiteten har på
 * resten av sidan, och en underskrift. Det inre bär valets lås och inget namn.
 *
 * `release` är markeringen som släcks: kuvertet går från din färg till samma
 * grå som alla andras, under den tid `at` och `dur` anger. `signAt` ritar
 * underskriften medan man ser på, i moment 4.
 */
function Envelope({
  kind,
  mark = 'none',
  at = 0,
  dur = 0.4,
  signAt,
}: {
  kind: 'outer' | 'inner'
  mark?: Mark
  at?: number
  dur?: number
  signAt?: number
}) {
  const size = kind === 'outer' ? OUTER : INNER
  const className = ['tl-envelope', mark === 'yours' && 'tl-yours', mark === 'release' && 'tl-release']
    .filter(Boolean)
    .join(' ')
  const style = mark === 'release' ? ({ '--d': `${at}s`, '--t': `${dur}s` } as CSSProperties) : undefined

  return (
    <g className={className} style={style}>
      <rect className="tl-env" width={size.w} height={size.h} rx={1.8} />
      <path
        className="tl-env-flap"
        d={`M0.6 0.6 L${size.w / 2} ${size.h * 0.52} L${size.w - 0.6} 0.6`}
      />
      {kind === 'inner' ? (
        <At x={size.w / 2} y={size.h * 0.74}>
          <LockGlyph />
        </At>
      ) : (
        <>
          <rect className="tl-name" x={3} y={size.h - 7} width={11} height={4.5} rx={1} />
          <path
            className={signAt === undefined ? 'tl-autograph' : 'tl-autograph tl-a tl-draw'}
            style={
              signAt === undefined
                ? undefined
                : ({ '--d': `${signAt}s`, '--t': '0.45s' } as CSSProperties)
            }
            d="M16 14.6 c0.9 -3 1.7 -3 2 -0.6 s1.1 1.8 1.9 -0.9 s1 -1.8 1.8 0.3"
            pathLength={1}
          />
        </>
      )}
    </g>
  )
}

/** Valets lås i litet format, som det sitter på varje inre kuvert. */
function LockGlyph() {
  return (
    <g className="tl-lock-glyph">
      <path d="M-1.9 -1.4 V-2.9 a1.9 1.9 0 0 1 3.8 0 V-1.4" />
      <rect x={-3.1} y={-1.5} width={6.2} height={4.6} rx={1} />
    </g>
  )
}

/** En nyckel med ringen i origo och spetsen rakt nedanför. */
function Key() {
  return (
    <g className="tl-key">
      <circle r={3} />
      <path d="M0 3 V14 M0 10.5 H3 M0 13.5 H2.6" />
    </g>
  )
}

function Trustee({ cx }: { cx: number }) {
  return (
    <g className="tl-person">
      <circle cx={cx} cy={17} r={6.5} />
      <path d={`M${cx - 10} 47 V35 a6 6 0 0 1 6 -6 h8 a6 6 0 0 1 6 6 V47 Z`} />
    </g>
  )
}

function Check({ r = 4.6 }: { r?: number }) {
  return (
    <g className="tl-check">
      <circle r={r} />
      <path d={`M${-r * 0.45} 0 L${-r * 0.1} ${r * 0.38} L${r * 0.5} ${-r * 0.36}`} />
    </g>
  )
}

function Magnifier() {
  return (
    <g className="tl-magnifier">
      <circle r={7} />
      <path d="M5 5 L10.5 10.5" />
    </g>
  )
}

/** En valsedel med tre alternativ och ett kryss, eller inget. */
function Ballot({ choice }: { choice?: 'B' | 'C' }) {
  return (
    <g>
      <rect className="tl-paper" x={21} y={27} width={36} height={52} rx={3} />
      {(['A', 'B', 'C'] as const).map((option, index) => {
        const y = 39 + index * 14
        return (
          <g key={option}>
            <rect className="tl-box" x={25} y={y - 4.5} width={9} height={9} rx={1.5} />
            <text className="tl-option" x={45} y={y + 3.6}>
              {option}
            </text>
          </g>
        )
      })}
      {choice && <Cross option={choice} />}
    </g>
  )
}

/** Krysset för ett alternativ, för sig, så att det kan flyttas till ett annat. */
function Cross({ option }: { option: 'B' | 'C' }) {
  const y = 39 + (option === 'B' ? 1 : 2) * 14
  return <path className="tl-cross" d={`M26.9 ${y} l2.4 2.6 l4.2 -5`} />
}

function IdCard() {
  return (
    <g className="tl-id">
      <rect x={21} y={34} width={36} height={24} rx={3} />
      <circle cx={30} cy={43.5} r={3.6} />
      <path d="M24 53.5 a6 4.6 0 0 1 12 0" />
      <path className="tl-id-lines" d="M39 42 H52 M39 47 H50 M39 52 H47" />
    </g>
  )
}

// ---------------------------------------------------------------------------
// Scenen
// ---------------------------------------------------------------------------

export function TimelineScene({ moment, animate }: { moment: Moment; animate: boolean }) {
  const n = moment.number

  return (
    <svg viewBox={VIEW_BOX} className={animate ? 'tl-scene' : 'tl-scene tl-still'}>
      <BinZone n={n} />
      <NamedUrnZone moment={moment} />
      <AnonUrnZone n={n} />
      <LockZone n={n} />
      <TrusteeZone n={n} />
      <PhoneZone moment={moment} />
      <Flight moment={moment} />
    </svg>
  )
}

// --- Din enhet --------------------------------------------------------------

function PhoneZone({ moment }: { moment: Moment }) {
  const n = moment.number
  const mark: Mark = moment.yourEnvelope === 'utpekad' ? 'yours' : 'none'

  return (
    <g className={zoneClass('phone', n)}>
      <rect className="tl-phone" x={PHONE.x} y={PHONE.y} width={PHONE.w} height={PHONE.h} rx={9} />
      <rect className="tl-screen" x={SCREEN.x} y={SCREEN.y} width={SCREEN.w} height={SCREEN.h} rx={3} />
      <path className="tl-phone-speaker" d="M33 15 H45" />
      <text className="tl-label" x={39} y={120}>
        Din enhet
      </text>

      {/* 2: legitimeringen. 3: den försvinner när du börjar rösta. */}
      {(n === 2 || n === 3) && (
        <A kind={n === 2 ? 'appear' : 'vanish'} dur={n === 2 ? 0.3 : 0.2}>
          <IdCard />
          <AnimateIf when={n === 2} kind="pop" at={0.45} dur={0.3}>
            <At x={39} y={74}>
              <Check r={8} />
            </At>
          </AnimateIf>
        </A>
      )}

      {/* 3: valsedeln fylls i och läggs i det inre kuvertet, här på enheten. */}
      {n === 3 && (
        <>
          <A kind="away" at={0.6} dur={0.45} dy={16}>
            <A kind="appear" at={0.15} dur={0.2}>
              <Ballot />
              <A kind="pop" at={0.35} dur={0.2}>
                <Cross option="B" />
              </A>
            </A>
          </A>
          <A kind="appear" at={0.5} dur={0.25} yours={mark === 'yours' && 'envelope'}>
            <At x={PHONE_INNER.x} y={PHONE_INNER.y} scale={PHONE_SCALE}>
              <Envelope kind="inner" mark={mark} />
            </At>
          </A>
        </>
      )}

      {/* 4: det inre kuvertet läggs i det yttre, och du skriver under. */}
      {n === 4 && (
        <g data-yours={mark === 'yours' ? 'envelope' : undefined}>
          <At x={PHONE_INNER.x} y={PHONE_INNER.y} scale={PHONE_SCALE}>
            <Envelope kind="inner" mark={mark} />
          </At>
          <A kind="pop" at={0.1} dur={0.35}>
            <At x={PHONE_OUTER.x} y={PHONE_OUTER.y} scale={PHONE_SCALE}>
              <Envelope kind="outer" mark={mark} signAt={0.6} />
            </At>
          </A>
        </g>
      )}

      {/* 5 och 6: skärmen visar din nuvarande röst. 7: den raderas. */}
      {n === 5 && (
        <A kind="appear" at={0.75} dur={0.3}>
          <Ballot choice="B" />
        </A>
      )}
      {n === 6 && (
        <>
          <Ballot />
          <A kind="vanish" dur={0.2}>
            <Cross option="B" />
          </A>
          <A kind="pop" at={0.15} dur={0.25}>
            <Cross option="C" />
          </A>
        </>
      )}
      {n === 7 && (
        <A kind="vanish" at={0.35} dur={0.4}>
          <Ballot choice="C" />
        </A>
      )}

      {/* 13: du ser att du har röstat, inte vad. */}
      {n === 13 && (
        <A kind="pop" at={0.1} dur={0.4}>
          <At x={39} y={50}>
            <Check r={11} />
          </At>
          <text className="tl-screen-text" x={39} y={79}>
            Röstat
          </text>
        </A>
      )}
    </g>
  )
}

// --- Förtroendepersonerna ----------------------------------------------------

function TrusteeZone({ n }: { n: number }) {
  return (
    <g className={zoneClass('trustees', n)}>
      {TRUSTEE_X.map((cx) => (
        <Trustee key={cx} cx={cx} />
      ))}
      <text className="tl-label" x={250} y={60}>
        Förtroendepersoner
      </text>

      {KEY_REST.map((rest, index) => {
        const toKeyhole = { dx: KEYHOLE_X[index]! - rest.x, dy: KEYHOLE_Y - 14 - rest.y }
        const usedToOpen = index < 2

        // 1: nycklarna kommer ur låsets tre nyckelhål och delas ut.
        if (n === 1) {
          return (
            <At key={index} x={rest.x} y={rest.y}>
              <A kind="move" at={0.5 + index * 0.08} dur={0.55} {...toKeyhole}>
                <A kind="appear" at={0.3} dur={0.15}>
                  <Key />
                </A>
              </A>
            </At>
          )
        }

        // 11: två av dem lämnas i låset, en i taget. Den tredje stannar hos
        // sin ägare.
        if (n === 11 && usedToOpen) {
          return (
            <At key={index} x={rest.x} y={rest.y}>
              <A kind="away" at={OPENING.keyAt[index]} dur={OPENING.keyDur} {...toKeyhole}>
                <Key />
              </A>
            </At>
          )
        }

        if (n > 11 && usedToOpen) return null

        return (
          <At key={index} x={rest.x} y={rest.y}>
            <Key />
          </At>
        )
      })}
    </g>
  )
}

// --- Låset och summakuvertet --------------------------------------------------

function LockZone({ n }: { n: number }) {
  return (
    <g className={zoneClass('lock', n)}>
      {/* 10: summakuvertet bildas runt låset. */}
      {n >= 10 && (
        <AnimateIf when={n === 10} kind="appear" at={0.55} dur={0.35}>
          <rect className="tl-card" x={CARD.x} y={CARD.y} width={CARD.w} height={CARD.h} rx={5} />
        </AnimateIf>
      )}
      {(n === 10 || n === 11) && (
        <A
          kind={n === 10 ? 'appear' : 'vanish'}
          at={n === 10 ? 0.55 : OPENING.shackleAt + 0.05}
          dur={0.25}
        >
          <path
            className="tl-card-flap"
            d={`M${CARD.x + 1} ${CARD.y + 1} L${CARD.x + CARD.w / 2} ${CARD.y + 25} L${CARD.x + CARD.w - 1} ${CARD.y + 1}`}
          />
        </A>
      )}

      {/* 11: bara summan blir läsbar, först när låset gått upp. */}
      {n >= 11 &&
        RESULT.map((row, index) => {
          const y = 85 + index * 12
          const width = row.count * 9
          return (
            <g key={row.option}>
              {/* Ingenting av innehållet syns förrän låset gått upp. */}
              <AnimateIf when={n === 11} kind="appear" at={OPENING.shackleAt + 0.1} dur={0.15}>
                <text className="tl-option" x={256} y={y + 4.2}>
                  {row.option}
                </text>
              </AnimateIf>
              <AnimateIf
                when={n === 11}
                kind="grow"
                at={OPENING.shackleAt + 0.1 + index * 0.05}
                dur={0.25}
              >
                <rect className="tl-bar" x={263} y={y - 3.5} width={width} height={7} rx={2} />
              </AnimateIf>
              <AnimateIf when={n === 11} kind="appear" at={OPENING.shackleAt + 0.3} dur={0.15}>
                <text className="tl-count" x={263 + width + 4} y={y + 4.2}>
                  {row.count}
                </text>
              </AnimateIf>
            </g>
          )
        })}

      {/* 12: låset har gjort sitt och försvinner. */}
      {n <= 11 && <BigLock n={n} />}
      {n === 12 && (
        <A kind="vanish" dur={0.3}>
          <BigLock n={n} />
        </A>
      )}

      {/* 12: resultatet granskas och får sitt bevis, där låset satt. */}
      {n === 12 && (
        <At x={290} y={97}>
          <A kind="sweep" dur={0.75} dx={-32}>
            <Magnifier />
          </A>
        </At>
      )}
      {n >= 12 && (
        <AnimateIf when={n === 12} kind="pop" at={0.45} dur={0.35}>
          <ProofSeal />
        </AnimateIf>
      )}

      <text className="tl-label" x={n >= 10 ? 249 : 224} y={134}>
        {n >= 12 ? 'Resultatet' : n >= 10 ? 'Summakuvertet' : 'Låset'}
      </text>
    </g>
  )
}

/** Beviset, i den del av summakuvertet där låset satt. */
function ProofSeal() {
  return (
    <g className="tl-proof">
      <At x={223} y={89}>
        <Check r={9} />
      </At>
      <text x={223} y={113}>
        Bevis
      </text>
    </g>
  )
}

/**
 * MOMENT 11: DELARNA AV NYCKELN LÄMNAS EN I TAGET.
 *
 * Förtroendepersonerna lämnar sina delar var för sig (spec 6.2). När den
 * första delen är på plats tänds dess nyckelhål, men ingenting händer. Först
 * när den andra är på plats går bygeln upp, och därefter blir summan läsbar.
 */
const OPENING = {
  /** När var och en av de två nycklarna börjar gå mot låset. */
  keyAt: [0, 0.5] as const,
  keyDur: 0.4,
  /** När dess nyckelhål tänds, alltså när delen är lämnad. */
  litAt: [0.4, 0.9] as const,
  /** När bygeln lyfts: först när båda delarna finns. */
  shackleAt: 1.0,
}

/**
 * Valets lås: ett lås med tre nyckelhål, ett per förtroendeperson, som går upp
 * när två av dem används. Före moment 11 är alla tre tomma.
 */
function BigLock({ n }: { n: number }) {
  const opened = n >= 11
  const shackle = <path className="tl-lock-shackle" d="M213 92 V83 a11 11 0 0 1 22 0 V92" />

  const parts = (
    <>
      {/* 11: bygeln lyfts först när båda delarna lämnats. */}
      {opened ? (
        <At x={0} y={-5}>
          <AnimateIf when={n === 11} kind="move" at={OPENING.shackleAt} dur={0.2} dy={5}>
            {shackle}
          </AnimateIf>
        </At>
      ) : (
        shackle
      )}
      <rect className="tl-lock-body" x={207} y={92} width={34} height={22} rx={4} />
      {KEYHOLE_X.map((x, index) => (
        <g key={x}>
          <Keyhole x={x} />
          {opened && index < 2 && (
            <AnimateIf when={n === 11} kind="appear" at={OPENING.litAt[index]} dur={0.1}>
              <Keyhole x={x} lit />
            </AnimateIf>
          )}
        </g>
      ))}
    </>
  )

  // 1: låset tillverkas. Nycklarna kommer sedan ur dess hål.
  return (
    <AnimateIf when={n === 1} kind="pop" dur={0.35}>
      {parts}
    </AnimateIf>
  )
}

function Keyhole({ x, lit = false }: { x: number; lit?: boolean }) {
  return (
    <g className={lit ? 'tl-keyhole tl-keyhole-lit' : 'tl-keyhole'}>
      <circle cx={x} cy={KEYHOLE_Y} r={2.2} />
      <rect x={x - 0.9} y={KEYHOLE_Y + 1.2} width={1.8} height={5} rx={0.9} />
    </g>
  )
}

// --- Urnan med namn -----------------------------------------------------------

function NamedUrnZone({ moment }: { moment: Moment }) {
  const n = moment.number
  const marked = moment.yourEnvelope === 'utpekad'

  return (
    <g className={zoneClass('named', n)}>
      <rect className="tl-urn tl-urn-named" x={NAMED.x} y={NAMED.y} width={NAMED.w} height={NAMED.h} rx={5} />
      <rect className="tl-slot" x={138} y={140} width={30} height={4} rx={2} />
      <text className="tl-label" x={126} y={206}>
        Urnan med namn
      </text>

      {/*
        7: urnan stängs och tar inte emot fler kuvert. Locket bär beskedet
        ensamt: en lapp med texten "Stängd" fick inte plats i läsbar storlek
        på en telefon, och texten bredvid scenen säger det.
      */}
      {n >= 7 && (
        <AnimateIf when={n === 7} kind="move" dur={0.4} dx={-26}>
          <rect className="tl-lid" x={135} y={137.5} width={36} height={7} rx={3.5} />
        </AnimateIf>
      )}

      {/* 5: de andras kuvert. Ditt eget flyger in i Flight nedan. */}
      {n >= 5 &&
        n <= 8 &&
        OTHER_SLOTS.map((slot, index) => (
          <At key={index} x={slot.x} y={slot.y}>
            <AnimateIf when={n === 5} kind="appear" at={index * 0.05} dur={0.3}>
              <Envelope kind="outer" />
            </AnimateIf>
          </At>
        ))}

      {/* 7 och 8: ditt kuvert ligger kvar i urnan, med namnet på. */}
      {(n === 7 || n === 8) && marked && (
        <g data-yours="envelope">
          <At x={YOUR_SLOT.x} y={YOUR_SLOT.y}>
            <Envelope kind="outer" mark="yours" />
          </At>
        </g>
      )}

      {/* 5–8: lappen "Din röst", som bara finns så länge namnet finns. */}
      {n >= 5 && n <= 8 && marked && (
        <g data-yours="tag">
          <AnimateIf when={n === 5} kind="pop" at={0.85} dur={0.3}>
            <YourVoteTag />
          </AnimateIf>
        </g>
      )}

      {/* 8: varje yttre kuvert kontrolleras medan namnet finns kvar. */}
      {n === 8 && (
        <>
          <At x={172} y={168}>
            <A kind="sweep" dur={1.2} dx={-92}>
              <Magnifier />
            </A>
          </At>
          {NAMED_SLOTS.map((slot, index) => (
            <At key={index} x={slot.x + OUTER.w} y={slot.y + 1}>
              <A kind="pop" at={0.25 + ((slot.x - 82) / 62) * 0.7} dur={0.25}>
                <Check />
              </A>
            </At>
          ))}
        </>
      )}

      {n === 9 && <StripNames releasing={moment.yourEnvelope === 'släcks'} />}

      {n >= 9 && (
        <AnimateIf when={n === 9} kind="appear" at={1.2} dur={0.25}>
          <text className="tl-empty" x={126} y={171}>
            tom
          </text>
        </AnimateIf>
      )}
    </g>
  )
}

function YourVoteTag() {
  return (
    <g>
      <rect className="tl-you-tag" x={94} y={119} width={64} height={18} rx={9} />
      <path className="tl-you-tag" d="M121 136.5 L126 142 L131 136.5 Z" />
      <text className="tl-you-tag-text" x={126} y={132.3}>
        Din röst
      </text>
    </g>
  )
}

/**
 * MOMENT 9: NAMNEN TAS BORT.
 *
 * Ordningen i tid är hela poängen:
 *
 *   0,15–0,60  de yttre kuverten, med namnen, glider mot papperskorgen och
 *              tonas ut. Under exakt samma tid släcks markeringen på ditt inre
 *              kuvert och lappen "Din röst". När namnet är borta är markeringen
 *              det också.
 *   0,60–1,00  de inre kuverten, nu lika varandra, samlas i en punkt mellan
 *              urnorna och försvinner där.
 *   0,90–1,47  lika många nya kuvert kommer ut ur punkten och sorteras in i
 *              urnan utan namn, i ett annat mönster än i urnan med namn. De är
 *              andra element än de som gick in, och inget av dem har någonsin
 *              burit markeringen.
 */
function StripNames({ releasing }: { releasing: boolean }) {
  const RELEASE = { at: 0.15, dur: 0.45 }

  return (
    <>
      {/* Kontrollens bockar från moment 8 försvinner först. */}
      {NAMED_SLOTS.map((slot, index) => (
        <At key={`check-${index}`} x={slot.x + OUTER.w} y={slot.y + 1}>
          <A kind="vanish" dur={0.2}>
            <Check />
          </A>
        </At>
      ))}

      {NAMED_SLOTS.map((slot, index) => {
        const yours = releasing && slot === YOUR_SLOT
        const toSorter = {
          dx: SORTER.x - (slot.x + 2 + INNER.w / 2),
          dy: SORTER.y - (slot.y + 1.5 + INNER.h / 2),
        }
        const toBin = { dx: BIN_MOUTH.x - slot.x, dy: BIN_MOUTH.y - slot.y }

        return (
          <g key={index}>
            {/* Det inre kuvertet, som låg dolt i det yttre. */}
            <At x={slot.x + 2} y={slot.y + 1.5}>
              <A kind="away" at={0.6} dur={0.4} {...toSorter} yours={yours && 'envelope'}>
                <Envelope kind="inner" mark={yours ? 'release' : 'none'} {...RELEASE} />
              </A>
            </At>
            {/* Det yttre kuvertet, med namnet, slängs. */}
            <At x={slot.x} y={slot.y}>
              <A kind="leave" {...RELEASE} {...toBin} yours={yours && 'name'} name>
                <Envelope kind="outer" mark={yours ? 'yours' : 'none'} />
              </A>
            </At>
          </g>
        )
      })}

      {releasing && (
        <A kind="vanish" {...RELEASE} yours="tag">
          <YourVoteTag />
        </A>
      )}
    </>
  )
}

// --- Urnan utan namn ----------------------------------------------------------

function AnonUrnZone({ n }: { n: number }) {
  return (
    <g className={zoneClass('anon', n)}>
      <rect className="tl-urn tl-urn-anon" x={ANON.x} y={ANON.y} width={ANON.w} height={ANON.h} rx={5} />
      <rect className="tl-slot" x={258} y={140} width={30} height={4} rx={2} />
      <text className="tl-label" x={246} y={206}>
        Urnan utan namn
      </text>

      {n >= 9 &&
        ANON_SLOTS.map((slot, index) => (
          <At key={index} x={slot.x} y={slot.y}>
            <AnimateIf
              when={n === 9}
              kind="scatter"
              at={0.9 + index * 0.03}
              dur={0.45}
              dx={SORTER.x - (slot.x + INNER.w / 2)}
              dy={SORTER.y - (slot.y + INNER.h / 2)}
            >
              {/* Ett kuvert i urnan utan namn. Inget av dem bär data-yours. */}
              <g data-anonymous="">
                <Envelope kind="inner" />
              </g>
            </AnimateIf>
            {/* 11: när låset går upp sitter låsen kvar på de enskilda kuverten. */}
            {n === 11 && (
              <At x={INNER.w / 2} y={INNER.h * 0.74}>
                <A kind="pop" at={OPENING.shackleAt + index * 0.03} dur={0.3}>
                  <g className="tl-lock-stays">
                    <LockGlyph />
                  </g>
                </A>
              </At>
            )}
          </At>
        ))}
    </g>
  )
}

// --- Papperskorgen -------------------------------------------------------------

function BinZone({ n }: { n: number }) {
  return (
    <g className={zoneClass('bin', n)}>
      <path className="tl-bin" d="M17 154 L53 154 L48.5 190 L21.5 190 Z" />
      <path className="tl-bin-rim" d="M14 154 H56" />
      <path className="tl-bin-lines" d="M28 161 L29 184 M35 161 V184 M42 161 L41 184" />
      <text className="tl-label" x={35} y={206}>
        Slängs
      </text>
    </g>
  )
}

// --- Det som färdas mellan platserna -----------------------------------------

/**
 * Kuvert på väg mellan två platser. De ritas överst och tonas aldrig ned, så
 * att ett kuvert som lämnar enheten inte bleknar när det byter zon.
 */
function Flight({ moment }: { moment: Moment }) {
  const n = moment.number
  const marked = moment.yourEnvelope === 'utpekad'
  const mark: Mark = marked ? 'yours' : 'none'
  const fromPhone = {
    dx: PHONE_OUTER.x - YOUR_SLOT.x,
    dy: PHONE_OUTER.y - YOUR_SLOT.y,
    s: PHONE_SCALE,
  }

  return (
    <g>
      {/* 5: ditt kuvert lämnar enheten och läggs i urnan. */}
      {n === 5 && (
        <At x={YOUR_SLOT.x} y={YOUR_SLOT.y}>
          <A kind="move" at={0.1} dur={0.7} {...fromPhone} yours={marked && 'envelope'}>
            <Envelope kind="outer" mark={mark} />
          </A>
        </At>
      )}

      {/* 6: det gamla kuvertet slängs oöppnat, och det nya tar dess plats. */}
      {n === 6 && (
        <>
          <At x={YOUR_SLOT.x} y={YOUR_SLOT.y}>
            <A
              kind="away"
              at={0.2}
              dur={0.5}
              dx={BIN_MOUTH.x - YOUR_SLOT.x}
              dy={BIN_MOUTH.y - YOUR_SLOT.y}
              yours={marked && 'envelope'}
            >
              <Envelope kind="outer" mark={mark} />
            </A>
          </At>
          <At x={YOUR_SLOT.x} y={YOUR_SLOT.y}>
            <A kind="move" at={0.45} dur={0.6} {...fromPhone} yours={marked && 'envelope'}>
              <A kind="appear" at={0.3} dur={0.15}>
                <Envelope kind="outer" mark={mark} />
              </A>
            </A>
          </At>
        </>
      )}

      {/* 10: kuverten räknas ihop till ett, medan de själva ligger kvar. */}
      {n === 10 &&
        ANON_SLOTS.map((slot, index) => (
          <At key={index} x={slot.x} y={slot.y}>
            <A
              kind="away"
              at={index * 0.06}
              dur={0.7}
              dx={SUM_TARGET.x - (slot.x + INNER.w / 2)}
              dy={SUM_TARGET.y - (slot.y + INNER.h / 2)}
            >
              <Envelope kind="inner" />
            </A>
          </At>
        ))}
    </g>
  )
}

// --- Figurerna för sig, för förklaringen ovanför tidslinjen -------------------

/**
 * En figur ur scenen, utan animation, för förklaringen av bildspråket. Samma
 * figurer som i tidslinjen, så att läsaren känner igen dem där.
 */
export function LegendIcon({ kind }: { kind: 'inner' | 'outer' | 'lock' | 'urns' }) {
  const figure =
    kind === 'inner' ? (
      <svg viewBox="-3 -3 28 21">
        <Envelope kind="inner" />
      </svg>
    ) : kind === 'outer' ? (
      <svg viewBox="-3 -3 32 24">
        <Envelope kind="outer" />
      </svg>
    ) : kind === 'lock' ? (
      <svg viewBox="200 67 48 50">
        <BigLock n={0} />
      </svg>
    ) : (
      <svg viewBox="-2 -2 60 28">
        <rect className="tl-urn tl-urn-named" x={0} y={4} width={26} height={20} rx={3} />
        <rect className="tl-slot" x={12} y={3} width={11} height={2.5} rx={1.2} />
        <rect className="tl-urn tl-urn-anon" x={30} y={4} width={26} height={20} rx={3} />
        <rect className="tl-slot" x={42} y={3} width={11} height={2.5} rx={1.2} />
      </svg>
    )

  return (
    <span className="tl-legend-icon" aria-hidden="true">
      {figure}
    </span>
  )
}
