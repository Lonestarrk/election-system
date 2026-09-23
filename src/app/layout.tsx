import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: 'Digitalt valsystem – proof of concept',
  description:
    'Teknisk demonstration av ett valsystem där väljarens identitet och röst aldrig kan kopplas ihop.',
  // Ingen indexering: en demo av ett valsystem som dyker upp i sökresultat kan
  // missförstås som ett riktigt val.
  robots: { index: false, follow: false },
}

/**
 * Ingen statisk förrendering.
 *
 * CSP:n innehåller ett nonce som är unikt per begäran. En statiskt genererad
 * sida skulle bära ett nonce från byggtillfället, medan svarsheadern har ett
 * nytt — de matchar inte, och skripten blockeras.
 *
 * Att sidorna renderas per begäran är dessutom rimligt i sig för ett
 * valsystem: ingenting här vinner på att cachas, och en cachad sida är en sida
 * som kan visa gammal information om en pågående omröstning.
 */
export const dynamic = 'force-dynamic'

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="sv">
      <body>
        <div className="poc-banner">
          Detta är en teknisk demonstration. Inga riktiga röster registreras och systemet är inte
          avsett för verkliga val.
        </div>

        <header className="site-header">
          <div className="site-header-inner">
            <Link href="/" className="brand">
              <span className="brand-mark" aria-hidden="true">
                ✓
              </span>
              Digitalt valsystem
            </Link>
            <nav className="site-nav">
              <Link href="/">Rösta</Link>
              <Link href="/verify">Verifiera röst</Link>
              <Link href="/architecture">Arkitektur</Link>
              <Link href="/admin">Administration</Link>
            </nav>
          </div>
        </header>

        {children}

        <footer className="site-footer">
          Proof of concept. Ett verkligt valsystem kräver oberoende säkerhetsgranskning, formell
          hotmodellering, juridisk prövning, tillgänglighetskrav och offentlig insyn — se
          SECURITY.md.
        </footer>
      </body>
    </html>
  )
}
