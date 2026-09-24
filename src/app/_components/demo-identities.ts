import type { DemoIdentity } from './BankIdLogin'

/**
 * Demoidentiteter. Motsvarar att olika personer skannar QR-koden.
 *
 * Används både när väljaren legitimerar sig och när hon skriver under sin
 * röst. Listan står här en gång, så att de två stegen inte kan erbjuda olika
 * personer: underskriften måste komma från samma person som legitimerade sig,
 * annars avvisas rösten, och det ska gå att visa i demon.
 *
 * Panelen finns bara så länge BankID är en attrapp — rutten den anropar
 * svarar 404 annars, och funktionen den bygger på slutar existera när mocken
 * byts ut.
 */
export const DEMO_IDENTITIES: DemoIdentity[] = [
  { personalNumber: '19900101-1234', label: 'Anna — röstberättigad' },
  { personalNumber: '19850515-2345', label: 'Kim — röstberättigad' },
  { personalNumber: '19701212-3456', label: 'Robin — röstberättigad' },
  { personalNumber: '19600301-5678', label: 'Charlie — röstberättigad' },
  { personalNumber: '19550707-6789', label: 'Mira — röstberättigad' },
  { personalNumber: '19991231-7890', label: 'Noa — röstberättigad' },
  { personalNumber: '20100101-4567', label: 'Elis — ej röstberättigad' },
  { personalNumber: '19420404-8901', label: 'Gunvor — annan kommun' },
]
