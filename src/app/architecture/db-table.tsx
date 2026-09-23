import type { CSSProperties, ReactNode } from 'react'
import type { CiphertextPreview } from '@/app/api/demo/database-state/route'

/**
 * Delarna som livevyns kort har gemensamt: tabellen med rubrik och märkning,
 * märkena, chifferutdraget och stilarna.
 *
 * Bara presentation. Ingenting här hämtar, minns eller jämför något, och
 * ingenting här vet vilken rad som tillhör vem. Det avgörs av den som anropar,
 * ur den aktuella bilden.
 */

export type Model = 'kuvert' | 'gammal' | 'båda'

/**
 * Vad en rad kan vara märkt med. `följs` och `väljaren` gäller bara
 * pending_vote respektive voter_status, och bara före stängningen. Ingen rad i
 * encrypted_vote märks någonsin (se follow-a-vote.ts, punkt 4).
 */
export type Mark = 'följs' | 'väljaren' | 'kopplingen'

export type Row = { key: string; cells: ReactNode[]; mark?: Mark }

export function DbTable({
  name,
  model,
  description,
  headers,
  rows,
  emptyNote,
  bare = false,
}: {
  name: string
  model?: Model
  description?: ReactNode
  headers: string[]
  rows: Row[]
  emptyNote?: string
  /** Utan rubrik och beskrivning, för en tabell som redan har en rubrik ovanför sig. */
  bare?: boolean
}) {
  return (
    <div style={bare ? undefined : { marginTop: '1.5rem' }}>
      {!bare && (
        <>
          <h3 style={tableHeadingStyle}>
            <span className="mono">{name}</span>
            {model && <ModelBadge model={model} />}
            <span className="muted small" style={{ fontWeight: 400 }}>
              {rowCount(rows.length)}
            </span>
          </h3>
          {description && <p className="muted small">{description}</p>}
        </>
      )}

      {rows.length === 0 ? (
        <p className="small" style={emptyStyle}>
          Tom. {emptyNote}
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {headers.map((header) => (
                  <th key={header}>{header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.key} style={row.mark ? markedRowStyle(row.mark) : undefined}>
                  {row.cells.map((cell, index) => (
                    <td key={index} className={typeof cell === 'string' ? 'mono' : undefined}>
                      {cell}
                      {index === 0 && row.mark && <MarkTag mark={row.mark} />}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

const MODEL_LABELS: Record<Model, string> = {
  kuvert: 'Kuvertmodellen',
  gammal: 'Gamla modellen',
  båda: 'Båda modellerna',
}

const MODEL_COLOURS: Record<Model, { background: string; borderColor: string }> = {
  kuvert: { background: 'var(--accent-soft)', borderColor: 'var(--accent)' },
  gammal: { background: 'var(--warning-soft)', borderColor: 'var(--warning)' },
  båda: { background: 'var(--surface-muted)', borderColor: 'var(--border-strong)' },
}

export function ModelBadge({ model }: { model: Model }) {
  return (
    <span style={{ ...badgeStyle, ...MODEL_COLOURS[model] }} title="Vilken röstmodell tabellen hör till">
      {MODEL_LABELS[model]}
    </span>
  )
}

/**
 * Fasen, färgad efter om kopplingen finns. Orange så länge ytterkuverten kan
 * finnas, grön när de enligt specen ska vara borta.
 */
export function PhaseBadge({ phase }: { phase: string }) {
  const linkMayExist = phase === 'OPEN' || phase === 'CLOSED' || phase === 'VALIDATED'
  return (
    <span
      className="mono"
      style={{
        ...badgeStyle,
        background: linkMayExist ? 'var(--warning-soft)' : 'var(--success-soft)',
        borderColor: linkMayExist ? 'var(--warning)' : 'var(--success)',
      }}
    >
      {phase}
    </span>
  )
}

function MarkTag({ mark }: { mark: Mark }) {
  return (
    <span style={{ ...badgeStyle, marginLeft: '0.5rem', fontFamily: 'var(--font)' }}>{mark}</span>
  )
}

function markedRowStyle(mark: Mark): CSSProperties {
  if (mark === 'kopplingen') return { background: 'var(--warning-soft)' }
  return { background: 'var(--accent-soft)' }
}

export function Cipher({ preview }: { preview: CiphertextPreview | null }) {
  if (!preview) return <span className="muted">okänt format</span>
  return (
    <span className="mono">
      {preview.pairs} × (c1, c2), c1 = {preview.c1}
    </span>
  )
}

export function ColumnList({ columns, highlight }: { columns: string[]; highlight?: string }) {
  return (
    <>
      {columns.map((column, index) => (
        <span key={column}>
          <span
            className="mono"
            style={
              column === highlight
                ? { background: 'var(--warning-soft)', padding: '0 0.2rem', borderRadius: 4 }
                : undefined
            }
          >
            {column}
          </span>
          {index < columns.length - 1 ? ', ' : ''}
        </span>
      ))}
    </>
  )
}

export function rowCount(count: number): string {
  return count === 1 ? '1 rad' : `${count} rader`
}

export function timestamp(iso: string | null): string {
  if (iso === null) return '—'
  return new Date(iso).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' })
}

// ---------------------------------------------------------------------------
// Stilar
//
// Inline, som på resten av sidan: CSP:n tillåter inline-stilar, och en egen
// stilmall för en enda sida vore en fil till att hålla i synk.
// ---------------------------------------------------------------------------

export const headerRowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.75rem',
}

const tableHeadingStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.5rem',
  marginBottom: '0.35rem',
}

const badgeStyle: CSSProperties = {
  display: 'inline-block',
  fontSize: '0.72rem',
  fontWeight: 600,
  lineHeight: 1.4,
  padding: '0.1rem 0.45rem',
  borderRadius: 999,
  border: '1px solid var(--border-strong)',
  background: 'var(--surface-muted)',
  color: 'var(--text)',
  whiteSpace: 'nowrap',
}

const emptyStyle: CSSProperties = {
  background: 'var(--surface-muted)',
  borderRadius: 'var(--radius)',
  padding: '0.6rem 0.8rem',
  color: 'var(--text-muted)',
}

export const preStyle: CSSProperties = {
  background: 'var(--surface-muted)',
  padding: '1rem',
  borderRadius: 'var(--radius)',
  overflowX: 'auto',
}

/**
 * Etiketten ovanför värdet, inte bredvid. På en telefon blev värdekolumnen
 * bredvid etiketterna så smal att ett id bröts mitt i, tecken för tecken.
 */
export const detailListStyle: CSSProperties = { margin: '0.75rem 0 0' }

export const detailTermStyle: CSSProperties = {
  marginTop: '0.5rem',
  color: 'var(--text-muted)',
  fontSize: '0.72rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
}

export const detailValueStyle: CSSProperties = { margin: 0, overflowWrap: 'anywhere' }
