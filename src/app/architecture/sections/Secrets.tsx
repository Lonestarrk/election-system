import type { ReactNode } from 'react'
import type { KnownLimitation } from '@/lib/known-limitations'
import { CURRENTLY } from '../code-facts'
import { LimitationReference, listItemStyle, type PageLimitations } from './shared'

/**
 * HEMLIGHETERNA I AZURE (uppgift 11g).
 *
 * I Azure ligger systemets hemligheter i Key Vault. Avsnittet säger vad som
 * ligger i valvet och vem som kommer åt det, vad som med avsikt inte ligger
 * där och vad valvet inte skyddar mot. Huvudsidan säger samma sak på
 * vardagsspråk, i tidslinjen och bland svagheterna.
 *
 * PÅSTÅENDENA OM MALLARNA LÄSES UR ../code-facts.ts och bär markörer mot
 * infra/azure, som påståendena om koden. Ändrar sessionen som äger mallarna
 * något som ett påstående bygger på går tests/security/architecture-page.test.ts
 * rött. Det som står här utan att komma därifrån är design, eller slutsatser ur
 * påståendena bredvid, och står som sådant.
 *
 * AVGRÄNSNINGEN ÄR POÄNGEN. Ett valv låter som ett skydd för allt det rör, och
 * den som tror det fattar sämre beslut än den som inte vet något om valvet.
 * Valvet håller hemligheterna utanför repot, imagen och databaserna. Det skyddar
 * inte mot den som får läsa det, inte mot appen, som har allt i minnet, och
 * inte mot den som driver uppsättningen. Och det tar inte bort kopplingen
 * mellan väljare och röst. Det gör raderingen vid stängningen, och i en kopia
 * från före stängningen öppnar pepparn fortfarande namnen.
 *
 * Att båda databasernas nycklar finns i samma app är ingen egen post i listan
 * över kända begränsningar. Modellen kräver det: stängningen flyttar chiffren
 * från röstlängden till röstdatabasen (spec 2), och kopplingen finns under
 * röstningen redan i röstlängden ensam. Rollerna per databas är en förstärkning
 * i Azure, och avsnittet säger vad den ger och inte ger.
 */
export function Secrets({
  limitations,
  municipality,
}: {
  limitations: PageLimitations
  /**
   * municipality-beside-identity-hash. Slås upp i technical/page.tsx och inte
   * i ./shared.tsx, som huvudsidan också läser: id:t innehåller ett fackord, och
   * huvudsidans filer får inte bära ett, inte ens i ett id.
   */
  municipality: KnownLimitation
}) {
  const { pepperHolder, dealer, demoIssuer, signingKeys } = limitations

  return (
    <section className="card" aria-labelledby="hemligheterna">
      <h2 id="hemligheterna">Hemligheterna i Azure</h2>
      <p className="muted small">
        I Azure ligger systemets hemligheter i Azure Key Vault, valvet på huvudsidan. Uppsättningen
        beskrivs i Bicep under <span className="mono">infra/azure</span>, och påståendena här om den
        bär markörer mot mallarna, som påståendena om koden. {CURRENTLY.vaultToEnvironment.text}
      </p>

      <div className="table-wrap" style={{ marginTop: '1rem' }}>
        <table className="prose-table stack-on-mobile">
          <thead>
            <tr>
              <th>Hemlighet</th>
              <th>Vad den används till, och av vem</th>
            </tr>
          </thead>
          <tbody>
            <SecretRow names={['identity-pepper']}>{CURRENTLY.vaultPepper.text}</SecretRow>
            <SecretRow names={['voters-database-url', 'votes-database-url']}>
              {CURRENTLY.vaultDatabaseUrls.text}
            </SecretRow>
            <SecretRow names={['vapid-public-key', 'vapid-private-key']}>
              {CURRENTLY.vaultVapid.text}
            </SecretRow>
            <SecretRow names={['pg-admin-password']}>{CURRENTLY.vaultPgAdmin.text}</SecretRow>
            <SecretRow names={['pg-voters-password', 'pg-votes-password']}>
              {CURRENTLY.vaultPgRolePasswords.text}
            </SecretRow>
          </tbody>
        </table>
      </div>

      <p className="muted small" style={{ marginTop: '1rem' }}>
        {CURRENTLY.vaultHoldsOnlyThese.text} {CURRENTLY.vaultSecretsCreatedOnce.text}
      </p>

      <h3>Vem som kommer åt valvet</h3>
      <p className="small">{CURRENTLY.vaultAccess.text}</p>
      <p className="small">
        {CURRENTLY.vaultSettings.text} {CURRENTLY.vaultNoAuditLog.text}
      </p>

      <h3>Vad valvet inte innehåller</h3>
      <ul className="small" style={{ paddingLeft: '1.25rem' }}>
        <li style={listItemStyle}>
          {CURRENTLY.sharesNotInVault.text} Det är avsiktligt. Tre andelar i samma valv vore inte tre
          innehavare: den som får läsa valvet hade kunnat öppna alla tre, och appen, som får läsa det,
          hade haft dem (spec 4.5).
        </li>
        <li style={listItemStyle}>
          {CURRENTLY.electionKeyNotStored.text} <LimitationReference entry={dealer} />
        </li>
        <li style={listItemStyle}>
          {CURRENTLY.mockIssuerInRepo.text} <LimitationReference entry={demoIssuer} />
        </li>
        <li style={listItemStyle}>
          {CURRENTLY.oldSigningKeysInDatabase.text} <LimitationReference entry={signingKeys} />
        </li>
      </ul>

      <h3>Vad valvet inte skyddar mot</h3>
      <ul className="small" style={{ paddingLeft: '1.25rem' }}>
        <li style={listItemStyle}>
          <strong>Den som får läsa valvet får pepparn.</strong> Med den gör hen identitetshashar av
          personnummer och prövar en person i taget mot röstlängden, där folkbokföringskommunen står
          bredvid hashen. <LimitationReference entry={municipality} /> Med pepparn och pending_vote
          får hen dessutom namn och personnummer för alla som har röstat, medan röstningen pågår.{' '}
          {CURRENTLY.azureBackups.text} <LimitationReference entry={pepperHolder} />
        </li>
        <li style={listItemStyle}>
          <strong>En komprometterad app har allt som valvet ger den.</strong>{' '}
          {CURRENTLY.appHoldsEverything.text}
        </li>
        <li style={listItemStyle}>
          <strong>Den som driver uppsättningen.</strong> {CURRENTLY.azureOwner.text}
        </li>
        <li style={listItemStyle}>
          <strong>Pepparn lämnar valvet.</strong> Appen räknar identitetshashen och kedjornas nyckel
          själv, med pepparn i minnet. Starkare vore att pepparn aldrig lämnade en HSM, och att
          hashningen och krypteringen av kedjorna gjordes där. Det är inte byggt.
        </li>
        <li style={listItemStyle}>
          <strong>Demon i Azure.</strong> {CURRENTLY.azureRunsDemo.text}{' '}
          <LimitationReference entry={demoIssuer} />
        </li>
        <li style={listItemStyle}>
          <strong>Utanför Azure finns inget valv.</strong> {CURRENTLY.secretsInFilesLocally.text}
        </li>
      </ul>

      <p className="muted small" style={{ marginBottom: 0 }}>
        Valvet tar inte bort kopplingen mellan väljare och röst. Det gör raderingen vid stängningen,
        och den når bara den levande databasen, inte säkerhetskopiorna.
      </p>
    </section>
  )
}

function SecretRow({ names, children }: { names: string[]; children: ReactNode }) {
  return (
    <tr>
      <td>
        {names.map((name) => (
          <span key={name} className="mono" style={{ display: 'block' }}>
            {name}
          </span>
        ))}
      </td>
      <td data-label="Vad den används till, och av vem">{children}</td>
    </tr>
  )
}
