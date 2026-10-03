import type { ElectionOverview } from '@/orchestration/election-overview.usecase'
import type { BallotResult } from '@/orchestration/publish-results.usecase'
import type { FinalCheckReport } from '@/orchestration/final-check.usecase'

/** Bara typer, som raderas i bygget. Sidan importerar ingen serverkod. */
export type { BallotResult, ElectionOverview, FinalCheckReport }

export type Tone = 'info' | 'success' | 'warning' | 'danger'

export type Notice = { tone: Tone; text: string }

export type ValidationSummary = {
  votes: number
  voters: number
  rejected: number
  byKind: Record<string, number>
  passed: boolean
}

/**
 * Det stängningens rutt svarade, som det är. `message` är serverns eget besked
 * och visas ordagrant. Valideringen och raderingen av kopplingen sker i samma
 * anrop (11d), så båda stegen visas ur samma svar.
 */
export type CloseView = {
  status: string
  httpStatus: number
  message: string
  moved?: number
  cleared?: number
  envelopeRoot?: string
  urnRoot?: string
  residueRemoved?: string[]
  urnRowsReplaced?: string[]
  summary?: ValidationSummary
  ciphertextHash?: string
}

/** Serverns besked för en förtroendepersons bidrag till en valsedel. */
export type ContributionResult = { ballotLabel: string; status: string; message: string }

export type FinalCheckView =
  | { status: 'none' }
  | { status: 'running'; startedAt: string }
  | { status: 'done'; report: FinalCheckReport }
  | { status: 'failed'; message: string }

export type ResultsView = { phase: string; ballots: BallotResult[] }
