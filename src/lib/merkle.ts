import { createHash } from 'node:crypto'

/**
 * MERKLETRÄD ÖVER RÖSTERNA
 *
 * Kravet är att registrerade röster inte ska kunna ändras eller tas bort utan
 * att det upptäcks. Den självklara lösningen vore en hashkedja där varje röst
 * pekar på den föregående — men den lösningen går inte att använda här, och
 * skälet är värt att förstå.
 *
 * VARFÖR INTE EN HASHKEDJA I INSÄTTNINGSORDNING
 *
 * En kedja kräver ett löpnummer, och ett löpnummer ÄR en ordning. Hela skälet
 * till att rösternas tidsstämpel är avrundad till timme är att de inte ska gå
 * att sortera i samma ordning som väljarna legitimerade sig — kan man det,
 * räcker det med båda databaserna för att para ihop väljare med röst. En kedja
 * i insättningsordning skulle alltså riva ned tidsskyddet för att bygga upp
 * manipulationsskyddet.
 *
 * LÖSNINGEN: ORDNINGEN KOMMER UR INNEHÅLLET
 *
 * Löven sorteras på sitt eget hashvärde, inte på när de skrevs. Trädet ser
 * likadant ut oavsett i vilken ordning rösterna kom in, och avslöjar därför
 * ingenting om tid. Samtidigt ändras roten om en enda röst ändras, läggs till
 * eller tas bort — vilket är precis den egenskap som krävs.
 *
 * En publicerad rot är alltså ett åtagande: "det här är exakt de röster som
 * fanns vid den tidpunkten". Vem som helst kan räkna om roten ur de publicerade
 * rösterna och jämföra.
 */

/**
 * Prefix som skiljer löv från interna noder.
 *
 * Utan dem är trädet sårbart för en klassisk attack: en angripare kan påstå
 * att en intern nod är ett löv och därmed konstruera ett falskt bevis. Att
 * hasha olika beroende på nodtyp stänger det.
 */
const LEAF_PREFIX = Buffer.from([0x00])
const NODE_PREFIX = Buffer.from([0x01])

/**
 * Prefix för själva roten, plus antalet löv.
 *
 * Utan det blir roten för ett träd med ETT löv identisk med lövet självt, och
 * roten för ett träd med två löv identisk med deras interna nod. En angripare
 * kan då presentera en intern nod som en giltig rot och påstå att
 * röstunderlaget var ett annat än det var.
 *
 * Att antalet löv hashas in stänger samma sorts förväxling en nivå till: två
 * olika mängder röster kan inte längre ge samma rot bara för att deras
 * trädstruktur råkar sammanfalla.
 */
const ROOT_PREFIX = Buffer.from([0x02])

function finalise(top: Buffer, leafCount: number): string {
  const count = Buffer.alloc(8)
  count.writeBigUInt64BE(BigInt(leafCount))
  return sha256(ROOT_PREFIX, count, top).toString('hex')
}

function sha256(...parts: Buffer[]): Buffer {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

/** Hashar ett löv. */
export function hashLeaf(content: string): string {
  return sha256(LEAF_PREFIX, Buffer.from(content, 'utf8')).toString('hex')
}

/**
 * Roten för en mängd löv.
 *
 * Löven sorteras — se resonemanget ovan. Ett tomt träd har en definierad rot
 * så att "inga röster ännu" är ett åtagande som går att publicera och
 * kontrollera, i stället för ett specialfall.
 */
export function merkleRoot(leafHashes: string[]): string {
  if (leafHashes.length === 0) {
    return finalise(sha256(LEAF_PREFIX), 0)
  }

  let level: Buffer[] = [...leafHashes].sort().map((hex) => Buffer.from(hex, 'hex'))

  while (level.length > 1) {
    const next: Buffer[] = []

    for (let index = 0; index < level.length; index += 2) {
      const left = level[index]!
      // Udda antal: noden lyfts upp oförändrad i stället för att dubbleras.
      // Att hasha en nod med sig själv öppnar för att två olika mängder löv
      // ger samma rot, vilket vore ett hål rakt igenom hela konstruktionen.
      const right = level[index + 1]
      next.push(right ? sha256(NODE_PREFIX, left, right) : left)
    }

    level = next
  }

  return finalise(level[0]!, leafHashes.length)
}

/**
 * Den kanoniska strängen för en röst.
 *
 * Detta är vad som hashas till ett löv, och vad en observatör måste kunna
 * återskapa exakt ur publicerade data för att kunna räkna om roten. Formatet
 * är därför enkelt, ordnat och utan något som kan formateras olika på olika
 * maskiner: inga datum, inga flyttal, ingen JSON med ogaranterad fältordning.
 *
 * Notera vad som INTE ingår: skapandetidpunkten. Tas den med blir trädet
 * beroende av tid igen, och två observatörer som hämtar data vid olika
 * tillfällen skulle räkna fram olika rötter.
 */
export function canonicalVoteRecord(vote: {
  tokenHash: string
  credentialId: string
  credentialSignature: string
  ballotId: string
  ballotPartyId: string | null
  candidateId: string | null
  optionId: string | null
}): string {
  return [
    vote.tokenHash,
    vote.credentialId,
    vote.credentialSignature,
    vote.ballotId,
    vote.ballotPartyId ?? '-',
    vote.candidateId ?? '-',
    vote.optionId ?? '-',
  ].join('|')
}

/**
 * Länken i åtagandekedjan.
 *
 * Varje åtagande hashar in det föregående åtagandets hash. Det gör att en
 * angripare inte kan skriva om historiken genom att ersätta ett gammalt
 * åtagande med ett som passar manipulerade röster — varje senare åtagande
 * skulle då inte längre stämma.
 *
 * Här ÄR ordningen med, och det är oproblematiskt: åtagandena är få,
 * publicerade och innehåller inga röster. Det är rösterna som inte får gå att
 * ordna, inte åtagandena om dem.
 */
export function commitmentHash(input: {
  sequence: number
  root: string
  voteCount: number
  previousHash: string | null
}): string {
  return sha256(
    NODE_PREFIX,
    Buffer.from(
      [input.sequence, input.root, input.voteCount, input.previousHash ?? 'GENESIS'].join('|'),
      'utf8',
    ),
  ).toString('hex')
}
