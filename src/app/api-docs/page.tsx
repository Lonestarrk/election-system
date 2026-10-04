import type { Metadata } from 'next'
import { SpecViewer } from './SpecViewer'

export const metadata: Metadata = {
  title: 'API-dokumentation',
}

/**
 * API:ets dokumentation, renderad ur /api/openapi.
 *
 * Specen är härledd ur valideringsschemana och beskriver bara det som är offentligt
 * eller ligger bakom en session. Sidan är offentlig, av samma skäl som specen.
 */
export default function ApiDocsPage() {
  return (
    <main className="mx-auto max-w-5xl px-4 py-8">
      <h1 className="text-2xl font-semibold">API-dokumentation</h1>
      <p className="mt-2 max-w-3xl text-sm">
        Specen är härledd ur samma scheman som rutterna validerar med, och beskriver det som är offentligt eller
        ligger bakom en röstsession eller adminsessionen. Du kan läsa den men inte köra anrop härifrån: ett anrop
        mot en riktig omröstning har riktiga följder. Själva specen hämtas från{' '}
        <a className="underline" href="/api/openapi">
          /api/openapi
        </a>
        .
      </p>
      <SpecViewer />
    </main>
  )
}
