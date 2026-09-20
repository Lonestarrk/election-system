import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),

      // De genererade Prisma-klienterna ligger i node_modules/.prisma/.
      // Node behandlar '.prisma/voters' som ett paketnamn (bara './' och '../'
      // räknas som relativa sökvägar), men Vites resolver gör inte det — därför
      // pekas de ut explicit här.
      '.prisma/voters': fileURLToPath(new URL('./node_modules/.prisma/voters', import.meta.url)),
      '.prisma/votes': fileURLToPath(new URL('./node_modules/.prisma/votes', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globalSetup: ['./tests/global-setup.ts'],
    setupFiles: ['./tests/setup.ts'],
    // Integrationstesterna delar databas. Parallella filer skulle trampa på
    // varandras räkneverk, så de körs i en och samma process.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
