import Link from 'next/link'
import { CURRENTLY } from '../code-facts'
import { TECHNICAL_PATH } from './shared'

/**
 * Azure-uppsättningen på Utvecklingsstatus (uppgift 11g): att den finns som
 * Bicep, vad som är byggt i den och vad som inte är det.
 *
 * Påståendena läses ur ../code-facts.ts och bär markörer mot infra/azure, som
 * ägs av sessionen som distribuerar till Azure. Vad valvet innehåller och inte
 * skyddar mot står på Tekniska detaljer, och sidan länkar dit i stället för att
 * säga det två gånger.
 */
export function AzureStatus() {
  return (
    <section className="card" aria-labelledby="azure">
      <h2 id="azure">Driftsättningen i Azure</h2>
      <p className="small">{CURRENTLY.azureSetupBuilt.text}</p>
      <p className="small">{CURRENTLY.azureRunsDemo.text}</p>
      <p className="small">{CURRENTLY.azureNotBuilt.text}</p>
      <p className="muted small" style={{ marginBottom: 0 }}>
        Vilka hemligheter som ligger i valvet, vem som kommer åt dem och vad valvet inte skyddar mot
        står under <Link href={`${TECHNICAL_PATH}#hemligheterna`}>Hemligheterna i Azure</Link> på
        Tekniska detaljer.
      </p>
    </section>
  )
}
