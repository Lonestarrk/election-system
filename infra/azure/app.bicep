// ---------------------------------------------------------------------------
// Steg 4: applikationen.
//
// EN REPLIKA, INTE FLER OCH INTE NOLL.
//
// MockBankID:s ordrar, hastighetsbegränsningen och antagningskön ligger i
// processens minne (src/modules/eligibility/bankid/MockBankIdService.ts,
// src/lib/rate-limit.ts, src/lib/admission-queue.ts). Med två repliker kan en
// legitimering startas på den ena och pollas på den andra, och gränserna
// gäller per replika. Med noll repliker försvinner pågående legitimeringar
// och varje kallstart kör migreringar och seedning innan första svaret.
//
// Hemligheterna hämtas ur Key Vault av appens identitet; inga värden står i
// mallen eller i containerns konfiguration.
// ---------------------------------------------------------------------------

param location string
param prefix string
param environmentId string
param environmentDefaultDomain string
param acrLoginServer string
param appIdentityId string
param keyVaultUri string
param image string

@description('Extra origins för CSRF-kontrollen utöver appens egen adress, kommaseparerade (t.ex. en egen domän).')
param extraAppOrigins string = ''

var appName = '${prefix}-app'
var appOrigin = 'https://${appName}.${environmentDefaultDomain}'

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: { app: 'election-system' }
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${appIdentityId}': {} }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        { server: acrLoginServer, identity: appIdentityId }
      ]
      secrets: [
        { name: 'identity-pepper', keyVaultUrl: '${keyVaultUri}secrets/identity-pepper', identity: appIdentityId }
        { name: 'voters-database-url', keyVaultUrl: '${keyVaultUri}secrets/voters-database-url', identity: appIdentityId }
        { name: 'votes-database-url', keyVaultUrl: '${keyVaultUri}secrets/votes-database-url', identity: appIdentityId }
        { name: 'vapid-public-key', keyVaultUrl: '${keyVaultUri}secrets/vapid-public-key', identity: appIdentityId }
        { name: 'vapid-private-key', keyVaultUrl: '${keyVaultUri}secrets/vapid-private-key', identity: appIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'app'
          image: image
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'APP_ORIGIN', value: empty(extraAppOrigins) ? appOrigin : '${appOrigin},${extraAppOrigins}' }
            { name: 'COOKIE_SECURE', value: 'true' }
            // Container Apps ingress (Envoy) lägger till klientens adress sist i X-Forwarded-For.
            { name: 'TRUSTED_PROXY_HOPS', value: '1' }
            { name: 'MOCK_BANKID_POLLS_UNTIL_COMPLETE', value: '2' }
            { name: 'VAPID_SUBJECT', value: 'mailto:valmyndigheten@example.org' }
            { name: 'IDENTITY_PEPPER', secretRef: 'identity-pepper' }
            { name: 'VOTERS_DATABASE_URL', secretRef: 'voters-database-url' }
            { name: 'VOTES_DATABASE_URL', secretRef: 'votes-database-url' }
            { name: 'VAPID_PUBLIC_KEY', secretRef: 'vapid-public-key' }
            { name: 'VAPID_PRIVATE_KEY', secretRef: 'vapid-private-key' }
          ]
          probes: [
            // Entrypoint migrerar och seedar innan servern lyssnar.
            {
              type: 'Startup'
              tcpSocket: { port: 3000 }
              initialDelaySeconds: 10
              periodSeconds: 15
              failureThreshold: 10
            }
            {
              type: 'Liveness'
              tcpSocket: { port: 3000 }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/elections', port: 3000 }
              periodSeconds: 15
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: { minReplicas: 1, maxReplicas: 1 }
    }
  }
}

output url string = 'https://${app.properties.configuration.ingress.fqdn}'
