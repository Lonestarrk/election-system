import Link from 'next/link'
import { KNOWN_LIMITATIONS, type KnownLimitation } from '@/lib/known-limitations'

/**
 * Det sektionerna på de tre sidorna har gemensamt: begränsningarna de hänvisar
 * till i löpande text, hur en hänvisning ser ut och länkarna mellan sidorna.
 */

/** Tekniska detaljer, där hela listan över kända begränsningar står. */
export const TECHNICAL_PATH = '/architecture/technical'
export const STATUS_PATH = '/architecture/status'

/**
 * En begränsning ur listan, efter id.
 *
 * Kastar om posten saknas. Sidorna hänvisar till den i löpande text, och en
 * hänvisning till en post som tagits bort betyder att texten runt omkring också
 * är fel. tests/security/architecture-page.test.ts fångar det innan sidan gör
 * det, genom att leta efter anropen i alla sidans filer.
 */
export function limitation(id: string): KnownLimitation {
  const found = KNOWN_LIMITATIONS.find((entry) => entry.id === id)
  if (!found) {
    throw new Error(`Arkitektursidan hänvisar till begränsningen "${id}", som inte finns i listan.`)
  }
  return found
}

/** Begränsningarna som sektionerna på Tekniska detaljer och Utvecklingsstatus hänvisar till. */
export type PageLimitations = {
  link: KnownLimitation
  bankIdOrder: KnownLimitation
  /** Det underskriften inte skyddar mot sedan uppgift 14f: att äkta kuvert tas bort eller läggs tillbaka. */
  removal: KnownLimitation
  revocation: KnownLimitation
  xmlAdapter: KnownLimitation
  dealer: KnownLimitation
  liveResults: KnownLimitation
  /** Den som har pepparn, som i Azure ligger i valvet, läser namnen i de liggande kuverten. */
  pepperHolder: KnownLimitation
  demoIssuer: KnownLimitation
  /** Det gamla flödets signeringsnycklar, som ligger i röstlängden och inte i valvet. */
  signingKeys: KnownLimitation
  /** Förbehållet om röstdatabasen, med en egen post sedan granskningen av 11g (M11). */
  swapCiphertext: KnownLimitation
  /** Demons lösenfraser är kända (granskningen av 11g, E3). */
  demoPassphrases: KnownLimitation
}

export function pageLimitations(): PageLimitations {
  return {
    link: limitation('link-exists-during-voting'),
    bankIdOrder: limitation('bankid-order-carries-link'),
    removal: limitation('operator-can-remove-or-restore-envelope'),
    revocation: limitation('no-revocation-check'),
    xmlAdapter: limitation('bankid-xmldsig-adapter-missing'),
    dealer: limitation('trusted-dealer'),
    liveResults: limitation('live-results-in-old-flow'),
    pepperHolder: limitation('pepper-holder-reads-voter-names'),
    demoIssuer: limitation('mock-issues-certificates-in-demo'),
    signingKeys: limitation('signing-keys-in-database'),
    swapCiphertext: limitation('votes-db-writer-can-swap-ciphertext'),
    demoPassphrases: limitation('demo-trustee-passphrases-known'),
  }
}

/** Adressen till en post i listan, från vilken sida som helst. */
export function limitationHref(entry: KnownLimitation): string {
  return `${TECHNICAL_PATH}#begransning-${entry.id}`
}

/**
 * En hänvisning till en post i listan, med rubriken ur listan.
 *
 * På Tekniska detaljer står listan längre ned på samma sida. Från
 * Utvecklingsstatus länkar hänvisningen dit.
 */
export function LimitationReference({
  entry,
  from = 'technical',
}: {
  entry: KnownLimitation
  from?: 'technical' | 'status'
}) {
  if (from === 'status') {
    return (
      <span className="muted">
        Står i listan på Tekniska detaljer som <Link href={limitationHref(entry)}>{entry.title}</Link>.
      </span>
    )
  }

  return (
    <span className="muted">
      Står i listan nedan som <a href={`#begransning-${entry.id}`}>{entry.title}</a>.
    </span>
  )
}

export const listItemStyle = { marginBottom: '0.6rem' }
