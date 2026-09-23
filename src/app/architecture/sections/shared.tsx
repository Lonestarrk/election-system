import type { KnownLimitation } from '@/lib/known-limitations'

/**
 * Det sektionerna har gemensamt: begränsningarna sidan hänvisar till i löpande
 * text, och hur en hänvisning ser ut.
 *
 * Sidan slår upp posterna och skickar dem hit. Uppslaget ligger kvar i
 * page.tsx, där tests/security/architecture-page.test.ts kontrollerar att
 * varje hänvisning pekar på en post som finns.
 */
export type PageLimitations = {
  link: KnownLimitation
  bankIdOrder: KnownLimitation
  chain: KnownLimitation
  dealer: KnownLimitation
  liveResults: KnownLimitation
}

/** En hänvisning till en post i listan längst ned, med rubriken ur listan. */
export function LimitationReference({ entry }: { entry: KnownLimitation }) {
  return (
    <span className="muted">
      Står i listan nedan som <a href={`#begransning-${entry.id}`}>{entry.title}</a>.
    </span>
  )
}

export const listItemStyle = { marginBottom: '0.6rem' }
