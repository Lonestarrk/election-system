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
              <Link href="/verifiera">Verifiera röst</Link>
              <Link href="/demo">Arkitektur</Link>
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
