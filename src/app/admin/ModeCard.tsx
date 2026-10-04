'use client'

import { useEffect, useState } from 'react'

/**
 * Lägeskortet överst på adminsidan (uppgift 17).
 *
 * Det visar läget, vilken BankID som används och checklistan för skarpt läge,
 * och ingenting mer. Det har ingen knapp, inget formulär och anropar bara
 * GET /api/admin/mode: läget sätts vid driftsättning och kan inte ändras
 * härifrån. Den som kommer åt en adminsession ska inte kunna slå på
 * attrapp-BankID åt alla.
 *
 * Kortet påstår inte mer än servern svarar. Det kallar inget läge "säkert" och
 * räknar inte kraven som uppfyllda om svaret inte kom.
 */

type Requirement = { id: string; met: boolean; detail: string; blocking: boolean }

type ModeResponse = {
  mode: 'DEMO' | 'SHARP'
  title: string
  /** Läget och BankID i en rad, till exempel "Skarpt läge, BankID testmiljö". */
  summary: string
  meaning: string
  bankId: { kind: 'mock' | 'test' | 'production' | 'none'; label: string }
  requirements: Requirement[]
}

type State = { kind: 'loading' } | { kind: 'failed' } | { kind: 'ready'; data: ModeResponse }

export function ModeCard() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch('/api/admin/mode', { cache: 'no-store' })
        if (!response.ok) throw new Error(String(response.status))
        const data = (await response.json()) as ModeResponse
        if (!cancelled) setState({ kind: 'ready', data })
      } catch {
        if (!cancelled) setState({ kind: 'failed' })
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [])

  if (state.kind === 'loading') {
    return (
      <div className="card" aria-busy="true">
        <h2>Läge</h2>
        <p className="muted small">Läser läget …</p>
      </div>
    )
  }

  if (state.kind === 'failed') {
    return (
      <div className="card">
        <h2>Läge</h2>
        <div className="notice warning" role="status">
          Läget gick inte att läsa från servern. Kortet visar ingenting om det tills svaret kommer.
        </div>
        <p className="muted small">Läget sätts vid driftsättning och kan inte ändras här.</p>
      </div>
    )
  }

  const { data } = state
  const unmetBlocking = data.requirements.filter((requirement) => !requirement.met && requirement.blocking)
  const warnings = data.requirements.filter((requirement) => !requirement.met && !requirement.blocking)
  const demo = data.mode === 'DEMO'

  return (
    <div className="card mode-card" data-mode={data.mode}>
      <h2>Läge</h2>

      <div className="mode-heading">
        <span className={`status-badge ${demo ? 'status-planned' : 'status-done'}`}>{data.title}</span>
        <span className="mode-bankid">
          BankID: <strong>{data.bankId.label}</strong>
        </span>
      </div>

      <p className="mode-summary">
        <strong>{data.summary}</strong>
      </p>

      <p>{data.meaning}</p>

      {data.bankId.kind === 'test' && (
        <div className="notice warning" role="status">
          BankID:s testmiljö: Vem som helst kan skaffa ett test-BankID för vilket personnummer som helst och
          rösta som den personen, så identiteten är inte säkrad. Det här är inte ett riktigt val.
        </div>
      )}

      <h3 className="mode-subheading">
        {demo
          ? `Vad som saknas för skarpt läge (${unmetBlocking.length} stoppande)`
          : `Kraven för skarpt läge (${unmetBlocking.length} stoppande ouppfyllda)`}
      </h3>

      <ul className="mode-requirements">
        {data.requirements.map((requirement) => (
          <li key={requirement.id} data-met={requirement.met} data-blocking={requirement.blocking}>
            <span
              className={`status-badge ${
                requirement.met ? 'status-done' : requirement.blocking ? 'status-planned' : 'status-out-of-scope'
              }`}
            >
              {requirement.met ? (requirement.blocking ? 'Uppfyllt' : 'Ingen varning') : requirement.blocking ? 'Stoppar' : 'Varning'}
            </span>{' '}
            <code>{requirement.id}</code>
            {!requirement.met && <div className="muted small">{requirement.detail}</div>}
          </li>
        ))}
      </ul>

      {warnings.length > 0 && !demo && <p className="muted small">Varningar stoppar inte start, men ska läsas.</p>}

      <p className="muted small">Läget sätts vid driftsättning och kan inte ändras här.</p>
    </div>
  )
}
