/**
 * Paketet levereras utan typer, och ett tredje paket (@types/swagger-ui-react) vore ett beroende
 * till. Här deklareras bara de egenskaper sidan använder.
 */
declare module 'swagger-ui-react' {
  import type { ComponentType } from 'react'

  const SwaggerUI: ComponentType<{
    url?: string
    supportedSubmitMethods?: string[]
    docExpansion?: 'list' | 'full' | 'none'
  }>
  export default SwaggerUI
}
