// PostgreSQL Flexible Server i ett delegerat subnät, utan publik ändpunkt.
// Burstable B1ms räcker för en demonstration; byt skuName för mer last.

param location string
param tags object
param serverName string
param version string
param adminLogin string
param delegatedSubnetId string
param privateDnsZoneId string
param skuName string = 'Standard_B1ms'
param skuTier string = 'Burstable'
param storageSizeGB int = 32

@secure()
param adminPassword string

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: serverName
  location: location
  tags: tags
  sku: { name: skuName, tier: skuTier }
  properties: {
    version: version
    administratorLogin: adminLogin
    administratorLoginPassword: adminPassword
    storage: { storageSizeGB: storageSizeGB, autoGrow: 'Enabled' }
    backup: { backupRetentionDays: 7, geoRedundantBackup: 'Disabled' }
    highAvailability: { mode: 'Disabled' }
    network: {
      delegatedSubnetResourceId: delegatedSubnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
    authConfig: { passwordAuth: 'Enabled', activeDirectoryAuth: 'Disabled' }
  }
}

resource votersDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'voters_db'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource votesDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'votes_db'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
  dependsOn: [votersDb]
}

output fqdn string = server.properties.fullyQualifiedDomainName
