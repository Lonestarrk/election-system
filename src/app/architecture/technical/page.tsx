import Link from 'next/link'
import { isDemoMode } from '@/lib/demo-mode'
import { LiveLinkQuestion } from '../LiveDatabaseView'
import { ArchitectureNav } from '../sections/ArchitectureNav'
import { BeforeAndAfterClose } from '../sections/BeforeAndAfterClose'
import { EnvelopeModel } from '../sections/EnvelopeModel'
import { FromMetaphorToTechnology } from '../sections/FromMetaphorToTechnology'
import { LimitationsList } from '../sections/LimitationsList'
import { Metadata } from '../sections/Metadata'
import { Phases } from '../sections/Phases'
import { Review } from '../sections/Review'
import { pageLimitations, STATUS_PATH } from '../sections/shared'
import { WhatItDoesNotGive } from '../sections/WhatItDoesNotGive'

/**
 * Tekniska detaljer.
 *
 * Allt det tekniska som huvudsidan inte tar upp: kuverten i databaserna,
 * faserna, vad som publiceras, vad signaturen skyddar mot och inte,
 * databasgränsen med frågan "vem röstade på vad", metadatariskerna och hela
 * listan över kända begränsningar. Sidan beskriver designen. Vad som är byggt
 * står på Utvecklingsstatus.
 *
 * Sidan ska kunna läsas av någon som misstror systemet. Den redovisar därför
 * också vad som INTE är löst. En arkitektursida som bara listar styrkor är
 * marknadsföring, och i ett valsystem är marknadsföring farligt: den som tror
 * att systemet klarar mer än det gör fattar sämre beslut än den som inte
 * känner till det alls.
 *
 * TRE KÄLLOR, INGEN AV DEM SKRIVEN HÄR
 *
 * Det sidan påstår om kodens nuvarande läge läses ur ../code-facts.ts. De
 * kända begränsningarna läses ur src/lib/known-limitations.ts. Databasernas
 * innehåll hämtas av livevyn. De två första bär markörer i koden och ett test
 * som går rött när en markör försvinner, så sidan kan inte bli inaktuell utan
 * att någon märker det. Det som står i sektionerna utan att komma ur någon av
 * dem är design, och ska stå som design: spec 3.1 och 6.1 i
 * docs/spec/2026-09-22-dubbla-kuvert.md.
 *
 * Frågan "Finns det någon koppling?" hämtar databasernas innehåll och finns
 * därför bara i demoläget.
 */
export default function TechnicalPage() {
  /** Samma predikat som huvudsidan och varje rutt under /api/demo frågar. */
  const demo = isDemoMode()
  const limitations = pageLimitations()

  return (
    <main>
      <div className="stack">
        <div>
          <ArchitectureNav current="/architecture/technical" />
          <h1>Tekniska detaljer</h1>
          <p className="muted">
            Systemet byggs om till dubbla kuvert, efter Estlands modell. I den modellen vet systemet
            under röstningen att du har röstat men inte på vad, och rösten går att ändra fram till
            stängningen. Vid stängningen skalas identiteten bort, och efteråt publiceras bara
            summorna. Här står hur det är tänkt att fungera, vad det skyddar mot och vad det inte
            skyddar mot.
          </p>
          <p className="muted small" style={{ marginBottom: 0 }}>
            Sidan beskriver designen. Vad som är byggt står på{' '}
            <Link href={STATUS_PATH}>Utvecklingsstatus</Link>.
            {demo &&
              ' I demoläget körs frågan om kopplingen mot databaserna som de ser ut just nu.'}
          </p>
        </div>

        <EnvelopeModel />
        <FromMetaphorToTechnology />
        <BeforeAndAfterClose />
        <Phases />
        <WhatItDoesNotGive limitations={limitations} />

        {/* --- Databasgränsen, ur databaserna just nu ------------------------- */}
        {demo ? (
          <LiveLinkQuestion />
        ) : (
          <section className="card" aria-labelledby="koppling">
            <h2 id="koppling">Finns det någon koppling?</h2>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Ja, med flit, medan röstningen pågår. I demoläget körs frågan &quot;vem röstade på
              vad&quot; här mot röstlängden, och svaret visas tillsammans med databasernas kolumner
              och nycklar. Utanför demoläget ställs frågan inte, eftersom svaret är en insiders vy av
              röstlängden, och rutten som lämnar ut den svarar 404.
            </p>
          </section>
        )}

        <Review limitations={limitations} />
        <Metadata limitations={limitations} />
        <LimitationsList />
      </div>
    </main>
  )
}
