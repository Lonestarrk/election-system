// ---------------------------------------------------------------------------
// Steg 3: ett manuellt Container Apps-jobb som kör db-init.sql.
//
// Postgres har ingen publik ändpunkt, så SQL:en måste köras inifrån VNet:et.
// Jobbet går i samma miljö som appen och startas av deploy.sh vid varje
// distribution. Imagen är postgres:17-alpine, importerad till registret så
// att distributionen inte beror på Docker Hub.
// ---------------------------------------------------------------------------

param location string
param prefix string
param environmentId string
param acrLoginServer string
param appIdentityId string
param keyVaultUri string
param postgresFqdn string
param postgresAdminLogin string
param psqlImage string

resource job 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-db-init'
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
      triggerType: 'Manual'
      replicaTimeout: 300
      replicaRetryLimit: 1
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [
        { server: acrLoginServer, identity: appIdentityId }
      ]
      secrets: [
        { name: 'pg-admin-password', keyVaultUrl: '${keyVaultUri}secrets/pg-admin-password', identity: appIdentityId }
        { name: 'pg-voters-password', keyVaultUrl: '${keyVaultUri}secrets/pg-voters-password', identity: appIdentityId }
        { name: 'pg-votes-password', keyVaultUrl: '${keyVaultUri}secrets/pg-votes-password', identity: appIdentityId }
      ]
    }
    template: {
      containers: [
        {
          name: 'psql'
          image: psqlImage
          resources: { cpu: json('0.25'), memory: '0.5Gi' }
          command: ['/bin/sh', '-c']
          args: [
            'printf "%s\\n" "$INIT_SQL" | psql -v ON_ERROR_STOP=1 -v voters_pw="$VOTERS_PW" -v votes_pw="$VOTES_PW"'
          ]
          env: [
            { name: 'PGHOST', value: postgresFqdn }
            { name: 'PGUSER', value: postgresAdminLogin }
            { name: 'PGDATABASE', value: 'postgres' }
            { name: 'PGSSLMODE', value: 'require' }
            { name: 'PGPASSWORD', secretRef: 'pg-admin-password' }
            { name: 'VOTERS_PW', secretRef: 'pg-voters-password' }
            { name: 'VOTES_PW', secretRef: 'pg-votes-password' }
            { name: 'INIT_SQL', value: loadTextContent('db-init.sql') }
          ]
        }
      ]
    }
  }
}

output jobName string = job.name
