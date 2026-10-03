'use client'

import { useEffect, useState } from 'react'

/**
 * ÄR SIDAN I DEMOLÄGET? (uppgift 17c)
 *
 * Läget avgörs på servern av `isDemoMode()`, och layouten skriver det på
 * body som data-mode. Klientkomponenterna läser det därifrån, efter att sidan
 * har hydrerats, så att servern och webbläsaren ritar samma sak först.
 *
 * Svaret styr bara vad sidan visar, demopanelen med identiteterna. Det skyddar
 * ingenting: rutten panelen anropar frågar `isDemoMode()` själv och svarar 404 i
 * skarpt läge. Fram till att läget är läst är svaret nej, så att panelen aldrig
 * blinkar fram i skarpt läge.
 */
export function useDemoMode(): boolean {
  const [demo, setDemo] = useState(false)
  useEffect(() => {
    setDemo(document.body.dataset.mode === 'DEMO')
  }, [])
  return demo
}
