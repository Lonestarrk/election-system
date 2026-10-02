'use client'

import { useState } from 'react'
import type { ContributionResult, ElectionOverview } from './types'

/** Serverns status för ett bidrag, som ett ord. Beskedet i övrigt är serverns eget. */
const STATUS_WORDS: Record<string, string> = {
  accepted: 'Godkänd',
  rejected: 'Avvisad',
  duplicate: 'Redan lämnad',
  wrong_passphrase: 'Fel fras',
  wrong_phase: 'Fel fas',
  aborted: 'Avbruten',
  unknown_ballot: 'Okänd valsedel',
  unknown_trustee: 'Okänd förtroendeperson',
  tallied: 'Räknad',
  needs_more_trustees: 'Fler bidrag behövs',
  error: 'Misslyckades',
}

export function wordFor(status: string): string {
  return STATUS_WORDS[status] ?? 'Misslyckades'
}

/**
 * Räkningen: tre platser för förtroendepersonerna, och "Räkna" när två har
 * lämnat sina bidrag (uppgift 12c, punkt 5).
 *
 * Vilka som lämnat bidrag läses ur servern (`overview`), aldrig ur sidans egna
 * klick. Inlämningens besked visas som servern gav det, och frasen sparas
 * aldrig här: fältet töms så fort anropet är gjort.
 */
export function TallyStep(props: {
  overview: ElectionOverview
  demoMode: boolean
  busy: boolean
  results: Record<number, ContributionResult[]>
  tallyMessages: ContributionResult[]
  onSubmit: (trusteeIndex: number, passphrase: string) => Promise<void>
  onTally: () => void
  onFillDemo: (trusteeIndex: number) => Promise<string | null>
}) {
  const { overview } = props
  const [phrases, setPhrases] = useState<Record<number, string>>({})
  const active = overview.phase === 'STRIPPED'
  const ready = overview.trusteesReady.length
  const trustees = Array.from({ length: overview.trusteeCount }, (_, index) => index + 1)

  async function submit(index: number) {
    const phrase = phrases[index] ?? ''
    // Fältet töms direkt. Frasen ska inte ligga kvar i sidan efter anropet.
    setPhrases((current) => ({ ...current, [index]: '' }))
    await props.onSubmit(index, phrase)
  }

  return (
    <section className="card" aria-labelledby="tally-heading">
      <h2 id="tally-heading">2. Räkna</h2>

      <p>
        Det krävs <strong>{overview.trusteeThreshold} av {overview.trusteeCount}</strong> förtroendepersoner
        för att öppna summan av varje valsedel. Varje förtroendeperson lämnar sin fras en gång, och bidraget
        räknas för alla valsedlar i omröstningen. Det går inte att öppna en enskild väljares kuvert i det här
        steget, bara summan per valsedel.
      </p>

      <div className="notice info" style={{ marginBottom: '1rem' }}>
        <strong>Så går det till.</strong> Just nu skickas frasen till servern. Servern låser upp
        förtroendepersonens andel av nyckeln och räknar fram hennes partiella dekryptering, så den ser
        andelen en kort stund, och det gäller även utanför demon. I ett riktigt val ska varje
        förtroendeperson räkna på sin egen enhet och bara skicka sitt bidrag med bevis, så att servern
        aldrig ser en andel. Den vägen finns inte i appen än, se{' '}
        <a href="/architecture/status">Utvecklingsstatus</a> (posten om att servern ser förtroendepersonens
        andel). Frasen sparas och loggas inte av appen.
      </div>

      {!active && !['TALLIED', 'CERTIFIED'].includes(overview.phase) && (
        <p className="muted small">
          Fälten är avstängda. Räkningen börjar först när kopplingen är raderad och fasen står i STRIPPED.
          Fasen är nu {overview.phase}.
        </p>
      )}

      <div className="stack" style={{ gap: '1rem' }}>
        {trustees.map((index) => {
          const done = overview.trusteesReady.includes(index)
          const forBallots = overview.ballots.filter((ballot) => ballot.contributedBy.includes(index)).length
          const results = props.results[index] ?? []
          return (
            <fieldset key={index} className="trustee-slot">
              <legend>Förtroendeperson {index}</legend>

              <p className="small" style={{ marginBottom: '0.6rem' }}>
                {done
                  ? `Har lämnat sitt bidrag för alla ${overview.ballots.length} valsedlar.`
                  : `Har lämnat sitt bidrag för ${forBallots} av ${overview.ballots.length} valsedlar.`}
              </p>

              <label htmlFor={`phrase-${index}`}>Fras för förtroendeperson {index}</label>
              <input
                id={`phrase-${index}`}
                type="password"
                autoComplete="off"
                value={phrases[index] ?? ''}
                disabled={!active || props.busy || done}
                onChange={(event) => setPhrases((current) => ({ ...current, [index]: event.target.value }))}
              />

              <div className="button-row" style={{ marginTop: '0.75rem' }}>
                <button
                  type="button"
                  disabled={!active || props.busy || done || (phrases[index] ?? '') === ''}
                  onClick={() => void submit(index)}
                >
                  Lämna bidrag
                </button>
                {props.demoMode && (
                  <button
                    type="button"
                    className="secondary"
                    disabled={!active || props.busy || done}
                    onClick={() =>
                      void props.onFillDemo(index).then((phrase) => {
                        if (phrase !== null) setPhrases((current) => ({ ...current, [index]: phrase }))
                      })
                    }
                  >
                    Fyll i demofrasen
                  </button>
                )}
              </div>

              {results.length > 0 && (
                <ul className="trustee-results" aria-label={`Serverns besked till förtroendeperson ${index}`}>
                  {results.map((result, position) => (
                    <li key={position}>
                      <strong>{result.ballotLabel}: {wordFor(result.status)}.</strong> {result.message}
                    </li>
                  ))}
                </ul>
              )}
            </fieldset>
          )
        })}
      </div>

      <div style={{ marginTop: '1.25rem' }}>
        <p className="small">
          {ready} av {overview.trusteeCount} förtroendepersoner har lämnat bidrag för alla valsedlar.{' '}
          {overview.ballots.filter((ballot) => ballot.tallied).length} av {overview.ballots.length} valsedlar är räknade.
        </p>
        <div className="button-row">
          <button
            type="button"
            disabled={!active || props.busy || ready < overview.trusteeThreshold}
            onClick={props.onTally}
          >
            Räkna
          </button>
        </div>
        {active && ready < overview.trusteeThreshold && (
          <p className="muted small" style={{ marginTop: '0.5rem' }}>
            Knappen blir aktiv när {overview.trusteeThreshold} förtroendepersoner har lämnat godkända bidrag.
          </p>
        )}
        {props.tallyMessages.length > 0 && (
          <ul className="trustee-results" aria-label="Serverns besked om räkningen">
            {props.tallyMessages.map((result, position) => (
              <li key={position}>
                <strong>{result.ballotLabel}: {wordFor(result.status)}.</strong> {result.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
