// ---------------------------------------------------------------------------
// Steg 1: Key Vault.
//
// Eget steg eftersom infra.bicep hämtar Postgres-administratörens lösenord ur
// valvet med getSecret(), och det kräver att valvet redan finns när den
// mallen utvärderas.
//
// RBAC-läge: appens identitet får läsa hemligheter genom en rolltilldelning
// på just det här valvet (se infra.bicep), inte genom åtkomstpolicyer.
// enabledForTemplateDeployment låter en Bicep-distribution läsa hemligheter
// med getSecret() utan att distributören behöver en dataplansroll.
// ---------------------------------------------------------------------------

param location string
param keyVaultName string

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
  location: location
  properties: {
    tenantId: subscription().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enabledForTemplateDeployment: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    publicNetworkAccess: 'Enabled'
  }
}

output keyVaultName string = kv.name
output keyVaultUri string = kv.properties.vaultUri
