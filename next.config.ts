import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const projectRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  output: 'standalone',
  reactStrictMode: true,

  // Låser filspårningens rot till projektmappen i stället för att låta Next
  // leta uppåt i katalogträdet. Gör bygget oberoende av var projektet ligger.
  outputFileTracingRoot: projectRoot,

  // Prisma körs som ett vanligt Node-beroende på servern i stället för att
  // buntas av webpack. Dess runtime laddar frågemotorn med dynamiska
  // require-anrop som inte går att lösa upp statiskt.
  //
  // Besläktat: de genererade klienterna hamnar i node_modules/.prisma/ (se
  // prisma/*/schema.prisma), inte under src/. Prisma kopierar sin runtime till
  // utdatakatalogen, och den filen anropar os.homedir(). Ligger den utanför
  // node_modules försöker Next.js filspårning expandera anropet statiskt och
  // skanna hela användarkatalogen — vilket kraschar bygget på Windows, där
  // hemkatalogen innehåller junctions som inte går att läsa
  // (C:\Users\<namn>\Cookies → EPERM). Next hoppar alltid över node_modules.
  serverExternalPackages: ['@prisma/client'],

  // Gränssnittet är på svenska, så verifieringssidan ligger på /verifiera.
  // /verify finns kvar som permanent omdirigering: det är sökvägen
  // specifikationen anger, och en länk dit ska inte gå i stöpet.
  async redirects() {
    return [{ source: '/verify', destination: '/verifiera', permanent: true }]
  },

  // Säkerhetsheaders sätts även i middleware (som täcker API-rutter och
  // dynamiska svar). Här sätts de på statiska svar som inte passerar
  // middleware-kedjan.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig
