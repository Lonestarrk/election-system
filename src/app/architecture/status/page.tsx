import { ArchitectureNav } from '../sections/ArchitectureNav'
import { AzureStatus } from '../sections/AzureStatus'
import { OldFlow } from '../sections/OldFlow'
import { PhasesToday } from '../sections/PhasesToday'
import { Remaining } from '../sections/Remaining'
import { ReviewToday } from '../sections/ReviewToday'
import { limitation, pageLimitations } from '../sections/shared'
import { StatusOverview } from '../sections/StatusOverview'

/**
 * Utvecklingsstatus: vad som är byggt av kuvertmodellen och vad som inte är
 * det, vad det gamla flödet fortfarande gör, vad som återstår och, sedan
 * uppgift 11g, vad som finns av driftsättningen i Azure.
 *
 * VARJE PÅSTÅENDE HÄR OM KODEN LÄSES UR ../code-facts.ts OCH BÄR MARKÖRER.
 * Ändras koden så att ett påstående slutar stämma går
 * tests/security/architecture-page.test.ts rött, och påståendet ska skrivas
 * om. Sidan kan alltså bli inaktuell bara genom att någon struntar i ett rött
 * test, inte genom att någon glömmer den.
 *
 * Sidan hämtar ingenting och visar inga databaser, så den ser likadan ut i och
 * utanför demoläget.
 */
export default function StatusPage() {
  const limitations = pageLimitations()

  return (
    <main>
      <div className="stack">
        <div>
          <ArchitectureNav current="/architecture/status" />
          <h1>Utvecklingsstatus</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            Kuvertmodellen byggs i etapper. Här står vad som finns i koden i dag, vad det gamla
            röstflödet fortfarande gör och vad som återstår. Varje påstående om koden på sidan är
            kopplat till koden med en markör, och testerna går rött när koden ändras så att
            påståendet inte längre stämmer.
          </p>
        </div>

        <StatusOverview />
        <ReviewToday limitations={limitations} />
        <PhasesToday />
        <OldFlow
          entries={[
            limitation('receipt-proves-choice'),
            limitation('live-results-in-old-flow'),
            limitation('signing-keys-in-database'),
            limitation('no-guaranteed-anonymity-set'),
          ]}
        />
        <Remaining
          fixable={[limitations.bankIdOrder, limitations.revocation, limitations.xmlAdapter]}
        />
        <AzureStatus />
      </div>
    </main>
  )
}
