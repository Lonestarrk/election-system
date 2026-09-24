// ---------------------------------------------------------------------------
// Skriver EN hemlighet till Key Vault via kontrollplanet (ARM).
//
// deploy.sh anropar den bara för hemligheter som ännu inte finns, så att en
// ny distribution aldrig byter ut ett befintligt värde. Det är avgörande för
// identity-pepper: byts den matchar ingen hash i röstlängden längre.
//
// Värdet skickas i en parameterfil i en temporär katalog, aldrig på
// kommandoraden, och @secure() håller det borta ur distributionshistoriken.
// ---------------------------------------------------------------------------

param keyVaultName string
param secretName string

@secure()
param secretValue string

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = {
  parent: kv
  name: secretName
  properties: {
    value: secretValue
    contentType: 'text/plain'
  }
}
