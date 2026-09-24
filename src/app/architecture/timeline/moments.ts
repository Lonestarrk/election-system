/**
 * TIDSLINJENS MOMENT: HELA OMRÖSTNINGEN I TRETTON STEG.
 *
 * Tidslinjen på arkitektursidan är skriven för den som aldrig har hört ordet
 * kryptering. Liknelsen får förenkla, men varje förenkling måste vara sann
 * enligt specen, docs/spec/2026-09-22-dubbla-kuvert.md avsnitt 2, 3, 3.1, 6
 * och 6.1. En läsare som inte kan kontrollera förklaringen själv är just den
 * läsare som tar skada av en förklaring som lovar för mycket.
 *
 * Texten här bär hela berättelsen. Animationen är dekorativ och dold för
 * skärmläsare, så allt som animationen visar ska också stå i texten.
 * tests/unit/timeline-moments.test.ts prövar att texterna säger det liknelsen
 * måste säga, och att inga fackord smugit sig in.
 *
 * Filen är bara data. Tidslinjen hämtar ingenting och läser ingenting ur
 * databasen eller livevyn: den är en simulering av hur valet är tänkt att
 * fungera, inte en bild av vad som finns i databasen just nu.
 */

/** Var i omröstningen momentet ligger. Visas ovanför momentets rubrik. */
export type Stage =
  | 'Före röstningen'
  | 'Medan röstningen pågår'
  | 'Vid stängningen'
  | 'Räkningen'
  | 'Efteråt'

/**
 * Om animationen pekar ut ditt kuvert.
 *
 *   'ingen'    ingenting pekas ut: det finns inget kuvert än, eller så är
 *              namnen borttagna och det går inte längre att se i urnan vilket
 *              som är ditt. Den som kopierade urnan innan dess kan fortfarande
 *              veta det, och huvudsidan säger det bland svagheterna.
 *   'utpekad'  ditt kuvert är markerat i momentets slutläge
 *   'släcks'   markeringen släcks under momentet, i samma ögonblick som
 *              namnet försvinner, och slutläget pekar inte ut något
 *
 * Efter momentet då namnen tas bort är varje moment 'ingen'. Ett kuvert som
 * animationen pekade ut efter skalningen vore den koppling modellen raderar,
 * visad för alla som tittar. Scenen ritar markeringen bara när fältet säger
 * det, och testet håller fältet rätt.
 */
export type YourEnvelope = 'ingen' | 'utpekad' | 'släcks'

export type Moment = {
  /** Ordningen, från 1. */
  number: number
  /** Kort etikett på knappen i tidslinjen. */
  label: string
  /** Rubriken ovanför texten. */
  title: string
  stage: Stage
  /** En till tre meningar på vardagsspråk. */
  text: string
  yourEnvelope: YourEnvelope
}

export const MOMENTS: readonly Moment[] = [
  {
    number: 1,
    label: 'Valet förbereds',
    title: 'Valet förbereds',
    stage: 'Före röstningen',
    text:
      'Innan röstningen öppnar skapas ett lås som vem som helst kan stänga, men som bara går upp ' +
      'när två av tre förtroendepersoner har lämnat var sin del av nyckeln. Ingen av dem kan öppna ' +
      'låset ensam. Men låset görs i ordning av den som driver systemet, och då finns hela nyckeln ' +
      'ett ögonblick på ett ställe innan den delas och förstörs.',
    yourEnvelope: 'ingen',
  },
  {
    number: 2,
    label: 'Du loggar in',
    title: 'Du loggar in med BankID',
    stage: 'Medan röstningen pågår',
    text: 'Du loggar in med BankID. Då vet systemet vem du är och vilka valsedlar du får rösta på.',
    yourEnvelope: 'ingen',
  },
  {
    number: 3,
    label: 'Du röstar',
    title: 'Du röstar på din egen enhet',
    stage: 'Medan röstningen pågår',
    text:
      'Du gör ditt val på din egen telefon eller dator. Där läggs valet i ett inre kuvert som ' +
      'låses med valets lås, innan något skickas. Ingen av förtroendepersonerna kan öppna ' +
      'kuvertet ensam.',
    yourEnvelope: 'utpekad',
  },
  {
    number: 4,
    label: 'Du skriver under',
    title: 'Du skriver under med BankID',
    stage: 'Medan röstningen pågår',
    text:
      'Du skriver under med BankID, och det inre kuvertet läggs i ett yttre kuvert med ditt namn ' +
      'på. Underskriften visar att kuvertet kommer från dig.',
    yourEnvelope: 'utpekad',
  },
  {
    number: 5,
    label: 'I urnan',
    title: 'Kuvertet läggs i urnan',
    stage: 'Medan röstningen pågår',
    text:
      'Kuvertet läggs i urnan, bland de andras. Ditt namn står på det med avsikt, så att kuvertet ' +
      'kan bytas ut om du ändrar dig. Systemet ser att du har röstat, men inte vad.',
    yourEnvelope: 'utpekad',
  },
  {
    number: 6,
    label: 'Du ändrar dig',
    title: 'Du ändrar dig',
    stage: 'Medan röstningen pågår',
    text:
      'Du kan ändra dig ända fram till stängningen: du skriver under på nytt, och ditt gamla kuvert ' +
      'byts ut och slängs utan att öppnas. Din skärm visar din nuvarande röst, men den kan inte ' +
      'bevisa för någon annan vad du har röstat på.',
    yourEnvelope: 'utpekad',
  },
  {
    number: 7,
    label: 'Röstningen stänger',
    title: 'Röstningen stänger',
    stage: 'Vid stängningen',
    text:
      'Röstningen stänger, och urnan tar inte emot fler kuvert. Så snart sidan ser att röstningen ' +
      'har stängt slutar din enhet visa din röst och raderar det den har sparat om den. Öppnar du ' +
      'aldrig sidan igen ligger uppgifterna kvar, men de bevisar ingenting för någon annan.',
    yourEnvelope: 'utpekad',
  },
  {
    number: 8,
    label: 'Kontrollen',
    title: 'Kontrollen',
    stage: 'Vid stängningen',
    text:
      'Medan namnen finns kvar kontrolleras varje yttre kuvert: att personen fick rösta, att ' +
      'underskriften är personens egen och att ingen har mer än ett kuvert. Hittas ett allvarligt ' +
      'fel tas ingenting bort, och röstningen förblir stängd medan felet utreds. Inget kuvert ' +
      'öppnas.',
    yourEnvelope: 'utpekad',
  },
  {
    number: 9,
    label: 'Namnen tas bort',
    title: 'Namnen tas bort',
    stage: 'Vid stängningen',
    text:
      'De yttre kuverten med namnen slängs, och de inre sorteras och flyttas till en urna utan ' +
      'namn, så att ordningen inte avslöjar vem som röstade när. Nu går det inte längre att se i ' +
      'urnan vilket kuvert som är ditt, inte heller i den här animationen. Men den som kopierade ' +
      'urnan medan namnen fanns kvar kan fortfarande veta det, och det står bland svagheterna nedan.',
    yourEnvelope: 'släcks',
  },
  {
    number: 10,
    label: 'Räkningen',
    title: 'Kuverten räknas ihop',
    stage: 'Räkningen',
    text:
      'Alla inre kuvert läggs ihop till ett enda summakuvert, utan att något av dem öppnas. Det ' +
      'går, eftersom kuverten är gjorda så att innehållet kan räknas ihop medan de är stängda.',
    yourEnvelope: 'ingen',
  },
  {
    number: 11,
    label: 'Summan öppnas',
    title: 'Summan öppnas',
    stage: 'Räkningen',
    text:
      'Två av de tre förtroendepersonerna lämnar var sin del av nyckeln, en i taget. Först när två ' +
      'delar finns går bara summakuvertet upp, och det visar hur många röster varje alternativ ' +
      'fick. De enskilda kuverten förblir stängda.',
    yourEnvelope: 'ingen',
  },
  {
    number: 12,
    label: 'Resultatet',
    title: 'Resultatet publiceras med bevis',
    stage: 'Räkningen',
    text:
      'Resultatet publiceras med ett bevis, så att vem som helst kan kontrollera att summan ' +
      'öppnades rätt. Att summan består av just de giltiga rösterna går inte att räkna om ' +
      'utifrån, utan bygger på kontrollen före stängningen.',
    yourEnvelope: 'ingen',
  },
  {
    number: 13,
    label: 'Efteråt',
    title: 'Efteråt',
    stage: 'Efteråt',
    text:
      'Efteråt ser du att du har röstat, men inte vad. Ingen annan kan se din röst heller, varken ' +
      'i urnan eller i resultatet.',
    yourEnvelope: 'ingen',
  },
]
