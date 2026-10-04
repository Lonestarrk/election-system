'use client'

import dynamic from 'next/dynamic'
import 'swagger-ui-react/swagger-ui.css'

/**
 * Swagger UI laddas bara i webbläsaren, efter att sidan hydrerat. Paketet går inte att rendera på
 * servern, och det ska inte följa med någon annan sida.
 *
 * Paketet och dess stilmall serveras från appen själv ('self'), så policyn behöver varken
 * 'unsafe-eval' eller någon extern källa. Se ARCHITECTURE.md.
 */
const SwaggerUI = dynamic(() => import('swagger-ui-react'), {
  ssr: false,
  loading: () => <p className="mt-6 text-sm">Läser in dokumentationen.</p>,
})

export function SpecViewer() {
  return (
    <div className="mt-6" data-testid="api-docs">
      {/* Inga anrop härifrån: "Try it out" av en rutt som stänger ett val är inget en demo ska erbjuda. */}
      <SwaggerUI url="/api/openapi" supportedSubmitMethods={[]} docExpansion="list" />
    </div>
  )
}
