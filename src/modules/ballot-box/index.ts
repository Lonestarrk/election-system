/**
 * Röstdatabasmodulens publika yta: omröstningarna och valsedlarna, sett från den anonyma sidan.
 *
 * Modulen lägger inga röster. Rösterna kommer in som kuvert, via röstlängdsmodulens
 * läggning, och flyttas hit först vid stängningen, efter att de yttre kuverten
 * validerats och kopplingen raderats (spec 6 och 7). Här finns bara det som är offentligt:
 * vilka valsedlar, partier, kandidater och svarsalternativ som finns, och formen på en
 * krypterad valsedel.
 *
 * Det finns ingen funktion som tar emot något som identifierar en person, och
 * modulen kan inte hämta identiteten på egen hand: dess Prisma-klient pekar på en annan
 * PostgreSQL-databas än röstlängden.
 */

import {
  createElection as createElectionInternal,
  deleteElection as deleteElectionInternal,
  getBallotChoices as getBallotChoicesInternal,
  getElection as getElectionInternal,
  getEncryptedBallotShape as getEncryptedBallotShapeInternal,
  listElections as listElectionsInternal,
  listOpenElections as listOpenElectionsInternal,
  listRegisteredParties as listRegisteredPartiesInternal,
} from './election.service'

export const listElections = listElectionsInternal
export const listOpenElections = listOpenElectionsInternal
export const getElection = getElectionInternal
export const getBallotChoices = getBallotChoicesInternal
export const getEncryptedBallotShape = getEncryptedBallotShapeInternal
export const listRegisteredParties = listRegisteredPartiesInternal
export const createElection = createElectionInternal
export const deleteElection = deleteElectionInternal

export type {
  Ballot,
  BallotChoices,
  BallotKind,
  CreateElectionInput,
  CreatedElection,
  Election,
  ElectionKind,
  EncryptedBallotShape,
  PartyChoice,
} from './election.service'
