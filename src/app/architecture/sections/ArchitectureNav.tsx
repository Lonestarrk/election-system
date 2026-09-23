import Link from 'next/link'
import { STATUS_PATH, TECHNICAL_PATH } from './shared'

const PAGES = [
  { href: '/architecture', label: 'Arkitektur' },
  { href: TECHNICAL_PATH, label: 'Tekniska detaljer' },
  { href: STATUS_PATH, label: 'Utvecklingsstatus' },
] as const

/**
 * Länkarna mellan arkitektursidan och dess två undersidor, överst på alla tre.
 *
 * Huvudsidan är skriven för den som aldrig hört ordet kryptering, och det
 * tekniska står på undersidorna. Länkarna står därför först, så att den som
 * vill ha detaljerna hittar dem utan att läsa förklaringen först.
 */
export function ArchitectureNav({ current }: { current: (typeof PAGES)[number]['href'] }) {
  return (
    <nav aria-label="Arkitektur">
      <ul className="arch-nav">
        {PAGES.map((page) => (
          <li key={page.href}>
            <Link href={page.href} aria-current={page.href === current ? 'page' : undefined}>
              {page.label}
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
