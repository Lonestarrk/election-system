import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const projectRoot = dirname(fileURLToPath(import.meta.url))

const nextConfig: NextConfig = {
  output: 'standalone',

  /**
   * Skilda byggkataloger för utveckling och produktion.
   *
   * `next dev` och `next build` skriver annars till samma `.next`. Kör man ett
   * produktionsbygge medan dev-servern är uppe skriver bygget över de filer
   * dev-servern har i sitt minnesmanifest, och symptomen pekar åt helt fel
   * håll: sidan svarar 200 men stilmallen ger 404, och webbläsaren vägrar
   * tillämpa svaret som `text/plain` eftersom `X-Content-Type-Options: nosniff`
   * hindrar den från att gissa MIME-typ. Det ser ut som ett CSS-fel.
   *
   * Det stod som en varning i README ett tag. Varningen räckte inte — jag gick
   * i fällan igen en commit senare. Konfiguration som gör felet omöjligt är
   * bättre än dokumentation som beskriver det.
   *
   * `next dev` sätter NODE_ENV till development; `next build` och `next start`
   * sätter production. Ingen skriptändring och inget nytt beroende behövs.
   */
  distDir: process.env.NODE_ENV === 'development' ? '.next-dev' : '.next',
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

  /**
   * De gamla svenska sökvägarna, som TILLFÄLLIGA omdirigeringar.
   *
   * Sökvägarna i appen är engelska; bara gränssnittet är på svenska. De fyra
   * rutterna nedan låter en gammal svensk länk eller bokmärke fortsätta
   * fungera medan de hittar fram till sin nya, engelska sökväg.
   *
   * VARFÖR permanent: false OCH INTE true
   *
   * En permanent omdirigering (308) cachas av webbläsaren på enheten, inte
   * bara av en server eller proxy däremellan. Här stod tidigare precis en
   * sådan, åt andra hållet: /verify → /verifiera, permanent. Vändes den bara
   * om läser webbläsaren sitt eget cachade minne först: en enhet som en gång
   * besökt /verify minns att den ska till /verifiera, och möter sedan den nya
   * omdirigeringen tillbaka — en loop som sitter i webbläsaren och överlever
   * att servern rättas. Ett proof of concept har inget sökmotorbehov som
   * motiverar permanent, och permanent gör varje framtida namnbyte till
   * samma sorts loop.
   */
  async redirects() {
    return [
      { source: '/legitimera', destination: '/identify', permanent: false },
      { source: '/rosta', destination: '/vote', permanent: false },
      { source: '/verifiera', destination: '/verify', permanent: false },
      { source: '/demo', destination: '/architecture', permanent: false },
    ]
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
