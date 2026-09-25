import { hashLeaf, merkleRoot } from './merkle'

/**
 * URNROTEN (uppgift 12b, ruling 134).
 *
 * Kuvertroten binder chifferhash och signatur för varje kuvert, men
 * signaturerna raderas vid skalningen, så efter stängningen går den inte att
 * räkna om. Den som kan skriva i röstdatabasen hade då kunnat byta ut en rad i
 * urnan mot en ny, självkonsekvent rad med giltiga bevis, utan att någonting
 * märkte det. Urnroten binder i stället det som finns kvar efter skalningen:
 * valsedeln och chifferhashen för varje rad i urnan.
 *
 * Stängningen räknar roten ur de validerade kuverten, i den form de infogas,
 * och skriver den i röstlängden i samma sats som STRIPPED och kuvertroten, och i
 * posten LINK_CLEARED. Räkningen räknar om den ur urnan före varje bidrag och
 * före kombinationen, och slutkontrollen gör det igen. Roten är en hash och
 * publicerar ingenting per röst (spec 3.1).
 *
 * SÅ RÄKNAS ROTEN, så att den som inte har koden kan räkna om den:
 *
 *   1. Ett blad per rad i urnan: SHA-256 över byten 0x00 och UTF-8 av
 *      "valsystem/urnrot/v1|<valsedelns id>|<chifferhash>". Valsedelns id står
 *      som det lagras, och chifferhashen är 64 gemena hextecken, SHA-256 över
 *      valsedelns kanoniska chifferlista (spec 4.4).
 *   2. Bladen sorteras stigande på sina hashar, som hex med gemener. Varje rad
 *      ger ett blad, också två med samma valsedel och chifferhash (ruling 130),
 *      så att en borttagen kopia ändrar roten.
 *   3. Nivå för nivå hashas bladen parvis från vänster: SHA-256 över 0x01,
 *      vänster och höger, 32 byte vardera. En udda sista nod lyfts upp
 *      oförändrad, i stället för att hashas med sig själv.
 *   4. Roten är SHA-256 över 0x02, antalet blad som 8 byte big-endian och den
 *      översta noden, som 64 gemena hextecken. En urna utan rader har som
 *      översta nod SHA-256 över bara 0x00.
 *
 * Steg 2–4 är `merkleRoot` i merkle.ts, samma träd som kuvertroten. Prefixet i
 * bladet gör att ett urnblad aldrig kan tas för ett kuvertblad.
 *
 * VARFÖR VALSEDELN STÅR I BLADET. Chifferhashen binder inte valsedeln, och två
 * valsedlar i samma omröstning kan ha lika många alternativ. Utan valsedeln i
 * bladet hade en rad kunnat flyttas från en valsedel till en annan utan att
 * roten ändrades, och den som flyttade alla rader utom en från en valsedel hade
 * fått den kvarvarande radens röst öppnad.
 */
export const URN_LEAF_PREFIX = 'valsystem/urnrot/v1'

/** Det ur en rad i urnan som roten binder. */
export type UrnRow = { ballotId: string; ciphertextHash: string }

/** Ett blad, som 64 gemena hextecken. Se steg 1 ovan. */
export function urnLeaf(row: UrnRow): string {
  return hashLeaf(`${URN_LEAF_PREFIX}|${row.ballotId}|${row.ciphertextHash}`)
}

/** Roten över urnans rader, i vilken ordning de än kommer. Se steg 2–4 ovan. */
export function urnRootOf(rows: ReadonlyArray<UrnRow>): string {
  return merkleRoot(rows.map(urnLeaf))
}
