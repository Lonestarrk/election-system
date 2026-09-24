// ---------------------------------------------------------------------------
// Steg 2: allt utom själva applikationen.
//
//   VNet med två delegerade subnät
//     snet-aca   Container Apps-miljön (workload profiles, Consumption)
//     snet-pg    PostgreSQL Flexible Server, utan publik ändpunkt
//   Privat DNS-zon för Postgres, länkad till VNet:et
//   Log Analytics för containerloggarna
//   Container Registry (Basic, admin-användaren avstängd)
//   Användartilldelad identitet för appen, med två rolltilldelningar som
//   gäller BARA de två resurserna: AcrPull på registret och Key Vault Secrets
//   User på valvet. Ingenting på prenumerations- eller gruppnivå.
//   PostgreSQL Flexible Server med databaserna voters_db och votes_db
//   Container Apps-miljön
//
// TVÅ DATABASER I SAMMA SERVER, som i docker-compose.yml. Separationen är
// att en foreign key mellan databaser är omöjlig (se docker/postgres/init.sql).
// I Azure förstärks den av att appen ansluter med två olika roller, en per
// databas, som bara får ansluta till sin egen (se db-init.sql).
// ---------------------------------------------------------------------------

param location string
param prefix string
param keyVaultName string
param acrName string
param postgresServerName string
param postgresAdminLogin string = 'pgadmin'

@description('PostgreSQL major version.')
param postgresVersion string = '17'

var tags = { app: 'election-system' }

// Inbyggda roller, globala id:n.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

resource kv 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: keyVaultName
}

// --- Nätverk ---------------------------------------------------------------

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.60.0.0/16'] }
    subnets: [
      {
        name: 'snet-aca'
        properties: {
          addressPrefix: '10.60.0.0/23'
          delegations: [
            { name: 'aca', properties: { serviceName: 'Microsoft.App/environments' } }
          ]
        }
      }
      {
        name: 'snet-pg'
        properties: {
          addressPrefix: '10.60.2.0/24'
          delegations: [
            { name: 'pg', properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' } }
          ]
        }
      }
    ]
  }
}

resource pgDnsZone 'Microsoft.Network/privateDnsZones@2024-06-01' = {
  name: '${postgresServerName}.private.postgres.database.azure.com'
  location: 'global'
  tags: tags
}

resource pgDnsLink 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = {
  parent: pgDnsZone
  name: '${prefix}-vnet-link'
  location: 'global'
  properties: {
    virtualNetwork: { id: vnet.id }
    registrationEnabled: false
  }
}

// --- Loggar ----------------------------------------------------------------

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

// --- Register och identitet ------------------------------------------------

resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: acrName
  location: location
  tags: tags
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
  }
}

resource appIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-app-id'
  location: location
  tags: tags
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, appIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

resource kvSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(kv.id, appIdentity.id, keyVaultSecretsUserRoleId)
  scope: kv
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: appIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// --- PostgreSQL ------------------------------------------------------------

module postgres 'postgres.bicep' = {
  name: 'postgres'
  params: {
    location: location
    tags: tags
    serverName: postgresServerName
    version: postgresVersion
    adminLogin: postgresAdminLogin
    adminPassword: kv.getSecret('pg-admin-password')
    delegatedSubnetId: vnet.properties.subnets[1].id
    privateDnsZoneId: pgDnsZone.id
  }
  dependsOn: [pgDnsLink]
}

// --- Container Apps-miljön -------------------------------------------------

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
    vnetConfiguration: {
      infrastructureSubnetId: vnet.properties.subnets[0].id
      internal: false
    }
    workloadProfiles: [
      { name: 'Consumption', workloadProfileType: 'Consumption' }
    ]
    zoneRedundant: false
  }
}

output environmentId string = env.id
output environmentDefaultDomain string = env.properties.defaultDomain
output acrLoginServer string = acr.properties.loginServer
output appIdentityId string = appIdentity.id
output postgresFqdn string = postgres.outputs.fqdn
output postgresAdminLogin string = postgresAdminLogin
