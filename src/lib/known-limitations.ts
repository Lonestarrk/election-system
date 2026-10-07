/**
 * KÄNDA BEGRÄNSNINGAR — EN ENDA KÄLLA
 *
 * Listan fanns tidigare som prosa på tre ställen: arkitektursidan, SECURITY.md
 * och VERIFIABILITY.md. Följden blev förutsägbar. Ett problem som en senare
 * ändring löst stod kvar som ett kvarvarande problem på sidan långt efteråt —
 * och en sida som påstår att systemet är sämre än det är underminerar tilliten
 * lika säkert som en som påstår motsatsen.
 *
 * VARJE BEGRÄNSNING BÄR SITT EGET TEST
 *
 * Fältet `stillTrueIf` pekar ut något i källkoden som är sant SÅ LÄNGE
 * begränsningen finns kvar. Ett säkerhetstest kontrollerar varje sådan
 * markör och misslyckas när den försvinner.
 *
 * Det betyder att den som faktiskt löser ett problem inte kan glömma att
 * uppdatera listan: bygget går sönder tills posten är borttagen. Det är
 * omvänd logik jämfört med ett vanligt test — det failar när något blir
 * BÄTTRE, och det är hela poängen.
 *
 * Begränsningar utan `stillTrueIf` är sådana som inte går att läsa ur koden:
 * driftsrutiner, organisation, hur nycklar förvaras. De måste underhållas för
 * hand, och de är markerade så.
 */

/**
 * Markör i källkoden som bevisar att begränsningen finns kvar.
 *
 * `file` läses relativt projektroten. `contains` måste förekomma i den.
 * Försvinner strängen har problemet antagligen lösts, och testet kräver att
 * posten tas bort härifrån.
 */
export type LimitationMarker = { file: string; contains: string }

export type KnownLimitation = {
  id: string
  title: string
  /** Varför det är allvarligt, i klartext för den som läser arkitektursidan. */
  why: string
  /**
   * En markör, eller flera när posten påstår flera saker om koden. Med flera
   * måste alla hålla: posten står kvar så länge vart och ett av påståendena i
   * den är sant, och den som löser en del av problemet får skriva om texten.
   */
  stillTrueIf?: LimitationMarker | LimitationMarker[]
}

export const KNOWN_LIMITATIONS: KnownLimitation[] = [
  /**
   * Begränsningarna gäller modellen med dubbla kuvert, och är sanna i koden i dag. Varje post bär
   * en markör, och testet tvingar bort posten när markören försvinner.
   */
  {
    id: 'link-exists-during-voting',
    title: 'Kopplingen väljare↔röst finns medan röstningen pågår',
    why:
      'Modellen med dubbla kuvert kräver kopplingen — det är den som gör rösten utbytbar, så ' +
      'att en köpt röst kan ersättas ända fram till stängningen. Priset är att "kan inte ' +
      'existera" blivit "raderas enligt schema". Backuper, läsreplikor och WAL-loggen omfattas ' +
      'inte av raderingen, och rösten är bara skyddad av att chiffret inte går att läsa utan k ' +
      'av n andelar. Det är den huvudsakliga akademiska invändningen mot Estlands system.',
    // PendingVote är det yttre kuvertet: väljarens id i samma rad som chiffret.
    // Så länge modellen finns, finns kopplingen medan röstningen pågår.
    stillTrueIf: { file: 'prisma/voters/schema.prisma', contains: 'model PendingVote' },
  },
  {
    id: 'trusted-dealer',
    title: 'Tröskelnyckeln delas av en betrodd utdelare',
    why:
      'Vid valets skapande existerar hela den privata nyckeln på ett ställe under ett ögonblick ' +
      'innan den delas och raderas. Riktig distribuerad nyckelgenerering låter förtroendemännen ' +
      'bygga nyckeln utan att den någonsin sätts ihop.',
    // Att dela en färdig nyckel ÄR den betrodda utdelaren. Vid distribuerad
    // nyckelgenerering finns ingen hel nyckel att dela, och anropet försvinner.
    // Markören är anropet med den hela nyckeln, inte bara namnet: namnet står
    // också i importraden och hade överlevt att anropet togs bort.
    stillTrueIf: {
      file: 'src/orchestration/create-election.usecase.ts',
      contains: 'splitSecret(keys.privateKey',
    },
  },
  /**
   * NY I UPPGIFT 12. Förtroendepersonen lämnar sin fras på adminsidan, och
   * servern räknar hennes bidrag. Spec 4.5 säger samma sak som en
   * kvarvarande svaghet, och utvecklingsstatus att ett riktigt val låter
   * förtroendepersonerna räkna på egna enheter.
   */
  {
    id: 'server-sees-trustee-share',
    title: 'Servern ser förtroendepersonens andel medan den räknar',
    why:
      'Förtroendepersonen skriver in sin fras på adminsidan, och servern låser upp hennes andel av ' +
      'nyckeln och räknar hennes bidrag till summan själv. Frasen sparas aldrig, och andelen ligger ' +
      'bara låst i databasen, men medan bidraget räknas finns båda i klartext i serverns minne, och ' +
      'den som har tagit sig in i appen vid ceremonin kan fånga dem. Med två andelar går varje ' +
      'chiffer i urnan att öppna, inte bara summan. Kopplingen till väljarna är då raderad, men en ' +
      'säkerhetskopia från före stängningen har kvar kuverten bredvid namnen, och två andelar öppnar ' +
      'dem också. Utanför demoläget skyddar frasen alltså andelarna i databasen och i ' +
      'säkerhetskopiorna, men inte mot den som har tagit över servern när andelarna används. I ett ' +
      'riktigt val räknar varje förtroendeperson på sin egen enhet och skickar bara bidraget med ' +
      'bevis, så att servern aldrig ser någon andel.',
    stillTrueIf: [
      // Servern låser upp andelen med frasen ...
      {
        file: 'src/orchestration/tally.usecase.ts',
        contains: 'const unlocked = unlockShare(trustee.encryptedShare, passphrase, gate.electionId, trusteeIndex)',
      },
      // ... som rutten tar emot.
      {
        file: 'src/app/api/admin/elections/decrypt/route.ts',
        contains: 'body.data.passphrase)',
      },
      // ... och adminsidan skickar frasen dit, och säger det (uppgift 12c).
      {
        file: 'src/app/admin/ElectionPanel.tsx',
        contains: "post('/api/admin/elections/decrypt', {",
      },
    ],
  },
  /**
   * UPPGIFT 14f ERSATTE POSTEN "BankID-certifikatkedjan valideras inte".
   *
   * Valideringen prövar nu varje kedja mot BankID:s rot och varje löv mot
   * väljarens identitet, och sedan fixrunda 1 flyttar stängningen exakt de
   * kuvert som validerats. Med riktig BankID kan den som bara kan skriva i
   * röstlängden därför inte längre lägga in en röst för någon som inte skrivit
   * under. Den som kan skriva i röstdatabasen kan än så länge byta ut ett
   * chiffer (spec 4.6, förbehåll 4), och det står sedan granskningen av 11g
   * som en egen post. De fem första posterna nedan är det som kedjan inte ger,
   * den sjätte är priset för att den lagras, och den sjunde gäller demons
   * lösenfraser.
   */
  {
    id: 'operator-can-remove-or-restore-envelope',
    title: 'Den som driver systemet kan ta bort ett kuvert eller lägga tillbaka en tidigare röst',
    why:
      'Med riktig BankID prövas varje underskrift mot BankID:s rot och mot väljarens identitet, och ' +
      'stängningen flyttar bara de kuvert som prövats, så den som kan skriva i röstlängden kan inte ' +
      'längre förfalska en ny. Det gäller röstlängden och inte röstdatabasen, som har en egen post ' +
      'nedan. I demon kan den som driver systemet fortfarande förfalska, eftersom ' +
      'attrappen utfärdar certifikaten själv. Men en äkta underskrift går att ta bort, och ' +
      'en väljares tidigare äkta kuvert går att lägga tillbaka i stället för hennes senaste. ' +
      'Räknaren som visar vilket kuvert som är det senaste lagras i samma databas, och den som ' +
      'lägger tillbaka det gamla kuvertet lägger tillbaka dess räknare, så valideringen före ' +
      'stängningen ser ingenting fel. Väljaren kan upptäcka båda före stängningen på enheten hon ' +
      'röstade från, där jämförelsen svarar att rösten ändrats eller att ingen röst finns. Vid ' +
      'skalningen skrivs markeringen "har röstat" för varje kuvert som flyttas, så ett borttaget ' +
      'kuvert ger ingen markering, medan ett återställt äldre kuvert ger en markering som vilket ' +
      'annat. Verifieringssidan visar markeringen efter stängningen, så väljaren ser där att ett ' +
      'borttaget kuvert saknas, men inte att ett äldre kuvert lagts tillbaka. Och den som kan skriva ' +
      'i röstlängden kan också skriva eller radera en markering efter stängningen, och då visar ' +
      'sidan det den skrev.',
    stillTrueIf: [
      // Räknaren som valideringen jämför med är radens egen. Kom den från
      // något som den som driver systemet inte kan skriva om, till exempel en
      // publicerad logg, ändrades raden.
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains: 'castSequence: vote.castSequence,',
      },
      { file: 'prisma/voters/schema.prisma', contains: 'castSequence Int @map("cast_sequence")' },
      // Verifieringssidans besked efter stängningen kommer ur markeringen i
      // röstlängden, som den som driver systemet kan skriva (uppgift 13).
      // Kommer beskedet en dag ur något som den inte kan skriva om ändras
      // raden, och texten ska ses över.
      { file: 'src/modules/eligibility/participation.service.ts', contains: ': await votersDb.votedMarker.count({ where })' },
    ],
  },
  /**
   * FLYTTAD UR POSTEN OVAN I GRANSKNINGEN AV 11g (M11).
   *
   * Förbehållet stod som en bisats i posten om den som driver systemet, fast
   * det gäller något annat: inte röstlängden, där underskriften skyddar, utan
   * röstdatabasen, där den inte gör det. Som bisats hade det ingen egen markör
   * och syntes inte på egen hand i listan.
   *
   * OMSKRIVEN I UPPGIFT 11D. Återläsningen stängde bytet före infogningen, men
   * bytet efter stängningen står kvar tills uppgift 12b räknar om en urnrot, och
   * ett byte före infogningen kan fortfarande stoppa stängningen.
   *
   * OMSKRIVEN I FIXRUNDA 1 AV 11D (ruling 126). Städningen ersätter nu en rad
   * som tagit ett validerat kuverts plats, så ett byte före stängningen stoppar
   * den inte längre. Kvar är fönstret mellan städningen och infogningen, där
   * ett byte stoppar en enskild körning, och bytet efter stängningen.
   *
   * RÄTTAD I FIXRUNDA 2 AV 11D (omgranskningens W2). Fönstret som stoppar
   * stängningen räcker till återläsningen, och ett byte efter den, före
   * skalningens COMMIT, räknas. Posten sa inget om det senare fönstret, och
   * sidtexten sa att varje byte under stängningen stoppade den.
   *
   * RÄTTAD I FIXRUNDA 3 AV 11D (ruling 130). Platsen i urnan är kuvertets id,
   * inte dess hash, eftersom två kuvert får ha samma chiffer. En rad med ett
   * äkta kuverts hash men ett annat id tar ingen plats. Den är en rest och tas
   * bort.
   *
   * UTÖKAD I UPPGIFT 12. Räkningen finns nu, och den prövar talens form men inte
   * rösternas bevis. En prob mot testdatabasen gav räkneverken [2, 1, 1] i
   * stället för [0, 2, 1], utan avbrott, för en tillagd rad med +2 på blankt
   * och −1 på S. Posten säger nu det, och att den som byter ut raderna
   * bestämmer vilken summa som öppnas.
   *
   * RÄTTAD I FIXRUNDA 1 AV UPPGIFT 12 (granskningens Mindre 3). Posten nämnde
   * inte att en borttagen rad tar bort en röst, fast det är enklast: prob p2 G
   * tog bort två av tre rader och fick [0, 1, 0]. Den nämnde "summerar till
   * antalet rader" bland kontrollerna, fast antalet räknas ur samma urna. Och
   * urnroten prövas nu i räkningens spärr, inte bara i slutkontrollen
   * (ruling 134).
   *
   * OMSKRIVEN I UPPGIFT 12b. Stängningen skriver en urnrot, och räkningen och
   * slutkontrollen räknar om den ur urnan. Den som bara kan skriva i
   * röstdatabasen kan därför inte längre byta ut ett chiffer, eller lägga till,
   * ta bort eller flytta en rad, obemärkt efter stängningen, men kan stoppa
   * räkningen. Kvar är
   * den som kan skriva i båda databaserna, som kan skriva om roten, och
   * fönstren före skalningens COMMIT, som stängningen själv inte ser. Titeln och
   * markörerna följer det.
   *
   * RÄTTAD I FIXRUNDA 1 AV 12b (granskningens Mindre 1). Posten sa att den som
   * kan skriva i båda databaserna också måste räkna om revisionskedjan för att
   * en annan urna ska räknas. Spärren läser bara roten i omröstningens rad, så
   * det räcker att skriva om den. Kedjan behövs bara för att komma förbi
   * slutkontrollen, och då är rösten redan öppnad. Uppgift 13 publicerar
   * urnroten (ruling 135), och posten har status Kommer (13) tills dess.
   *
   * OMSKRIVEN I UPPGIFT 13. Roten publiceras nu, från skalningen. Det stänger
   * att den som skriver i båda databaserna kan byta urna utan att någon utanför
   * kan se det, men bara för den som sparade roten, och räkningen stannar inte
   * för det. Spärren jämför fortfarande med raden i röstlängden.
   */
  {
    id: 'votes-db-writer-can-swap-ciphertext',
    title:
      'Den som kan skriva i röstdatabasen kan stoppa räkningen, och den som kan skriva i båda kan få en ' +
      'annan urna räknad',
    why:
      'Underskriften och kedjan skyddar det yttre kuvertet i röstlängden, inte chiffret i ' +
      'röstdatabasen, och kuvertroten går inte att räkna om när signaturerna är raderade. Därför ' +
      'räknar stängningen också en urnrot ur de validerade kuverten, en Merklerot över valsedel och ' +
      'chifferhash för varje flyttat kuvert, och skriver den i röstlängden och i revisionskedjan. ' +
      'Räkningen räknar om den ur urnan före varje bidrag och före kombinationen, och slutkontrollen ' +
      'gör det igen. Den som bara kan skriva i votes_db och byter ut ett chiffer, eller lägger till, tar ' +
      'bort eller flyttar en rad, efter stängningen får alltså ingen annan summa öppnad, men kan stoppa ' +
      'räkningen: roten stämmer inte, och ingenting dekrypteras. Den som kan skriva i båda databaserna ' +
      'behöver bara skriva om urnroten i omröstningens rad i röstlängden. Spärren läser inte ' +
      'revisionskedjan, så dekrypteringen öppnar då den urna hen har lagt dit, också en där alla rader ' +
      'utom en har känt innehåll. Slutkontrollen märker det efteråt, eftersom posten LINK_CLEARED bär ' +
      'roten som stängningen skrev, om inte revisionskedjan också räknas om. Då är rösten redan öppnad. ' +
      'Sedan uppgift 13 publiceras roten i observatörsgränssnittet från skalningen, före räkningen, och ' +
      'i det publicerade resultatet. Den som sparar den kan alltså se om den skrivs om efter att hen ' +
      'sparade den, men inte en rot som skrevs om före den första hämtningen. Ingenting i systemet ' +
      'stannar för det, och det syns bara om någon sparade den: varken ' +
      'räkningen eller publiceringen jämför med något utanför systemet. Räkningen ' +
      'prövar inte rösternas bevis igen, det gör slutkontrollen. Före stängningen kan den som skriver ' +
      'i röstdatabasen lägga en rad på ett äkta kuverts plats i urnan, dess id, men med ett annat ' +
      'innehåll, så att infogningen hoppar över det äkta kuvertet. Stängningen tar då bort raden och ' +
      'infogar det validerade kuvertet i stället, larmar i serverloggen och anger kuvertets ' +
      'chifferhash i svaret till administratören. Ett byte efter städningen men före återläsningen ' +
      'fångas av återläsningen, som avbryter stängningen med kopplingen orörd, och omkörningen ' +
      'ersätter raden. Den som vill hålla ett val från att stängas måste alltså skriva i det fönstret ' +
      'vid varje körning. Ett byte efter återläsningen och före skalningens COMMIT märker stängningen ' +
      'inte, men urnroten räknas ur de validerade kuverten och inte ur urnan, så räkningen vägrar ' +
      'sedan den urnan. Då är kuverten redan raderade ur röstlängden.',
    stillTrueIf: [
      // Infogningen hoppar över rader som redan finns, så en rad som skrivs
      // efter städningen stoppar stängningen i stället för att ersättas ...
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'skipDuplicates: true,' },
      // ... medan städningen ersätter en rad som redan låg där, på ett
      // validerat kuverts plats och med ett annat innehåll.
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: [
          '      const envelope = byPlace.get(row.id)',
          '      if (envelope && !storedAsValidated(row, envelope)) {',
          '        forged.push(envelope.ciphertextHash)',
          '        forgedRowIds.push(row.id)',
        ].join('\n'),
      },
      { file: 'src/app/api/admin/elections/close/route.ts', contains: 'urnRowsReplaced: outcome.urnRowsReplaced,' },
      // Urnroten räknas ur de validerade kuverten, inte ur urnan, och skrivs i
      // röstlängden med STRIPPED. Räknades den ur urnan hade ett byte efter
      // återläsningen kommit med i roten.
      { file: 'src/orchestration/close-election.usecase.ts', contains: 'const urnRoot = urnRootOf(placed)' },
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: "data: { phase: 'STRIPPED', linkClearedAt: truncateToHour(new Date()), envelopeRoot, urnRoot },",
      },
      // Räkningen jämför med roten i omröstningens rad i röstlängden, en
      // kolumn som den som kan skriva där kan skriva om, och spärren läser
      // roten därifrån och inte ur revisionskedjan. Jämförs den en dag med
      // kedjan eller med något utanför systemet ändras raderna, och texten ska
      // ses över.
      { file: 'src/orchestration/tally.usecase.ts', contains: 'if (root !== gate.urnRoot) {' },
      {
        file: 'src/orchestration/tally.usecase.ts',
        contains: 'select: { phase: true, envelopeRoot: true, urnRoot: true, ballots: { select: { id: true } } },',
      },
      { file: 'prisma/voters/schema.prisma', contains: 'urnRoot String? @map("urn_root")' },
      // Uppgift 13 publicerar roten (ruling 135). Publiceringens spärr jämför
      // också med raden i röstlängden och inte med något utanför systemet.
      // Gör den det en dag ändras raden, och texten ska ses över.
      {
        file: 'src/orchestration/tally.usecase.ts',
        contains: [
          '  return {',
          '    open: true,',
          '    electionId: ballot.electionId,',
          '    ballotId,',
          '    optionCount: shape.optionCount,',
          '    urnRoot: election.urnRoot,',
        ].join('\n'),
      },
      // Räkningen läser urnans chiffer men inte bevisen, så den prövar inte
      // rösternas bevis. Läser den bevisen ändras raden, och texten ovan ska
      // ses över.
      {
        file: 'src/orchestration/tally.usecase.ts',
        contains: 'select: { id: true, ciphertext: true, ciphertextHash: true },',
      },
    ],
  },
  /**
   * NY I FIXRUNDA 3 AV 11D (ruling 130). Fixrunda 2 avvisade en kopia av en
   * annans valsedel, och omgranskningens prob R129-E visade att avvisningen
   * var ett orakel för en köpare. Nu tas kopian emot, och det här är priset.
   * Specen säger samma sak i avsnitt 10.
   */
  {
    id: 'copied-ballot-counts',
    title: 'En kopia av någon annans valsedel räknas',
    why:
      'Bevisen i en valsedel binder den till omröstningen och valsedeln, men inte till väljaren. ' +
      'Den som har en annans hela krypterade valsedel kan därför lägga en kopia av den under sin ' +
      'egen underskrift, och kopian räknas som vilken röst som helst. Läggningen skiljer inte en ' +
      'kopia från en ny valsedel, eftersom ett svar som gjorde det vore ett orakel: en köpare som ' +
      'har valsedeln kunde då fråga, ända fram till stängningen, om den fortfarande är väljarens ' +
      'liggande röst. Priset är att den som har en annans chiffer och får många väljare att lägga ' +
      'kopior av det förskjuter summan för det alternativet, och kan därmed lära sig något om den ' +
      'väljarens röst. Det kräver chiffret med sina bevis före stängningen, och många medverkande. ' +
      'Bevisen publiceras aldrig, och ett chiffer publiceras bara som summa, efter stängningen.',
    stillTrueIf: [
      // Chifferhashen är unik varken bland kuverten eller i urnan. Ett unikt
      // index på någondera gör en kopia omöjlig att lägga eller att flytta.
      { file: 'prisma/voters/schema.prisma', contains: '  ciphertextHash String @map("ciphertext_hash")' },
      { file: 'prisma/votes/schema.prisma', contains: '  ciphertextHash String @map("ciphertext_hash")' },
      { file: 'prisma/votes/schema.prisma', contains: '  @@index([ciphertextHash])' },
      // Läggningen skriver kopian som vilket kuvert som helst, utan någon
      // prövning av chiffret mellan fasen och skrivningen ...
      {
        file: 'src/modules/eligibility/pending-vote.service.ts',
        contains: [
          "        return { status: 'closed' }",
          '      }',
          '',
          '      const replaced = await tx.pendingVote.updateMany({',
          '        where: { voterStatusId, ballotId, castSequence: { lt: signedPayload.castSequence } },',
          '        data: envelopeData,',
          '      })',
          "      if (replaced.count > 0) return { status: 'written', replaced: true }",
          '',
          '      const lying = await tx.pendingVote.findUnique({',
          '        where: { voterStatusId_ballotId: { voterStatusId, ballotId } },',
          '        select: { castSequence: true },',
          '      })',
          "      if (lying) return { status: 'stale_sequence' }",
          '',
          '      await tx.pendingVote.create({ data: { voterStatusId, ballotId, ...envelopeData } })',
        ].join('\n'),
      },
      // ... och valideringen har ingen kategori för den.
      {
        file: 'src/orchestration/validate-before-close.usecase.ts',
        contains:
          [
          '  kind:',
          "    | 'BAD_SIGNATURE'",
          "    | 'STALE_SEQUENCE'",
          "    | 'WRONG_BALLOT'",
          "    | 'BAD_PROOF'",
          "    | 'OLD_PROOF_FORMAT'",
          "    | 'OLD_SIGNATURE_FORMAT'",
          "    | 'OLD_BANKID_FORMAT'",
          '  pendingVoteId: string',
        ].join('\n'),
      },
    ],
  },
  /**
   * NY I FIXRUNDA 1 AV UPPGIFT 13 (ruling 138). Granskningen fann att en
   * valsedel med en enda rad i urnan publicerar den radens chiffer som summa,
   * medan texterna sa att ingenting publicerades per röst.
   */
  {
    id: 'single-row-ballot-publishes-the-vote',
    title: 'En valsedel med en enda röst publicerar den rösten som chiffer',
    why:
      'Resultatet publiceras per valsedel, med den krypterade summan per alternativ. Har valsedeln ' +
      'bara en rad i urnan är summan exakt den radens chiffer, och vem som helst kan räkna dess ' +
      'chifferhash ur det publicerade. Den som såg chiffret eller hashen när rösten lades, till ' +
      'exempel en köpare som såg skärmen, kan då se att just den rösten räknades och att väljaren ' +
      'inte ändrade sig, utan läsrätt i röstdatabasen. Vad rösten innehöll avslöjar redan talen: en ' +
      'valsedel med en röst visar den rösten, och det gäller varje system som publicerar summor, ' +
      'därför döljer riktiga val små tal. Chiffret lägger bara till frågan om just den rösten ' +
      'räknades. Inget skydd byggs: publiceringen spärrar inte valsedlar med få rader, och summan ' +
      'slumpas inte om före räkningen.',
    stillTrueIf: [
      // Summan publiceras som den räknades ur urnan, för varje valsedel.
      { file: 'src/orchestration/publish-results.usecase.ts', contains: 'c1: sum.c1.toString(),' },
      { file: 'src/orchestration/publish-results.usecase.ts', contains: 'options: recounted.sums.map((sum, optionIndex) => ({' },
    ],
  },
  /**
   * NY I FIXRUNDA 1 AV UPPGIFT 11e (ruling 141). Det signerade bär sedan 11e ett
   * saltat åtagande i stället för chifferhashen, men BankID har fortfarande resten
   * av det signerade, med väljarens identitet.
   */
  {
    id: 'bankid-knows-who-voted',
    title: 'BankID vet vem som röstade, på vilken valsedel, när och hur många gånger',
    why:
      'Med skarp BankID sparar BankID det väljaren skriver under, med hennes personnummer och ' +
      'tidpunkten, bland annat för tvister. Det signerade bär omröstningens och valsedelns id och ' +
      'räknaren, så BankID vet vem som röstade, på vilken valsedel, när och hur många gånger hon ' +
      'ändrade sig. Chifferhashen står inte där, utan en hash av den och ett salt som bara finns i ' +
      'kuvertet och raderas vid skalningen, så kopian pekar inte ut rösten i urnan. Det gäller inte ' +
      'en valsedel med så få röster att summan visar dem: där säger valsedelns id och summan vad ' +
      'väljaren röstade, salt eller inte, se posten "En valsedel med en enda röst publicerar den ' +
      'rösten som chiffer". En kopia av röstlängden från före stängningen har saltet kvar, och med ' +
      'den går BankID:s kopia att matcha, men den kopian har redan kopplingen själv.',
    stillTrueIf: [
      // Valsedelns id och räknaren ligger i det signerade. Tas de ut därifrån ändras
      // raderna, och posten ska ses över.
      {
        file: 'src/modules/eligibility/bankid/envelope-signature.ts',
        contains: [
          '    payload.ballotId,',
          '    payload.ciphertextCommitment,',
          '    String(payload.castSequence),',
        ].join('\n'),
      },
      { file: 'src/app/api/vote/sign-start/route.ts', contains: '    userNonVisibleData: envelopePayload({' },
    ],
  },
  {
    id: 'no-revocation-check',
    title: 'Ingen spärrkontroll av BankID-certifikaten',
    why:
      'Kedjan prövas mot BankID:s rot och mot certifikatens giltighetstid, men ingen frågar om ' +
      'certifikatet har spärrats. Ett BankID som spärrats, till exempel för att telefonen stulits, ' +
      'godkänns alltså så länge certifikatet gäller i tid. Riktig BankID skickar med ett OCSP-svar ' +
      'som visar certifikatets status vid underskriften, och det är det som ska prövas, både när ' +
      'rösten läggs och i valideringen före stängningen. Sedan uppgift 17b sparas BankID:s svar ' +
      'förseglat tillsammans med underskriften, men ingenting prövar det: attrappen har inget sådant ' +
      'svar, och kedjeprövningen tar inte emot något. Dessutom kommer tiden för underskriften i valideringen ' +
      'ur kuvertets updatedAt, som den som kan skriva i databasen kan ändra. Ett certifikat som ' +
      'gått ut godkänns därför om raden bakdateras till en dag då det gällde. Det kräver ett äkta ' +
      'certifikat och dess privata nyckel, och tidpunkten i OCSP-svaret hade stängt också det.',
    // Prövningen tar emot rötterna och tidpunkten för underskriften, och
    // ingenting annat. En spärrkontroll behöver ett OCSP-svar in, och då
    // ändras just den här raden.
    stillTrueIf: {
      file: 'src/modules/eligibility/bankid/certificate-chain.ts',
      contains: 'options: { roots: readonly X509Certificate[]; signedDuring: SigningWindow },',
    },
  },
  {
    id: 'mock-issues-certificates-in-demo',
    title: 'I demoläget utfärdar attrappen certifikaten själv',
    why:
      'Attrappen är sin egen certifikatutfärdare, och mellannivåns privata nyckel är incheckad i ' +
      'koden som testfixtur. Den som driver en demo kan därför utfärda ett giltigt certifikat för ' +
      'vilket personnummer som helst och förfalska en underskrift som valideringen godkänner. ' +
      'Skyddet gäller med riktig BankID, där nyckeln finns hos BankID och inte hos den som driver ' +
      'systemet. Testerna visar egenskapen mot attrappens inbyggda rot, vars privata nyckel ' +
      'kastades när den skapats: en kedja till en annan rot, ett certifikat för fel väljare, ett ' +
      'utgånget certifikat och ett löv med CA-rätt underkänns, var och ett av sin egen kontroll. ' +
      'En mellannivå utan CA-rätt prövas under en egen rot som testet litar på, eftersom ingen ' +
      'längre kan utfärda en mellannivå under attrappens.',
    stillTrueIf: [
      // Attrappen utfärdar med den incheckade nyckeln ...
      {
        file: 'src/modules/eligibility/bankid/MockBankIdService.ts',
        contains: "from './mock-ca/issuing-ca-test-key'",
      },
      // ... och i demoläget är attrappens rot den som kedjan prövas mot.
      {
        file: 'src/modules/eligibility/bankid/trusted-roots.ts',
        contains: 'if (isDemoMode()) return [mockBankIdRoot()]',
      },
    ],
  },
  /**
   * OMSKRIVEN I UPPGIFT 17b OCH 17c. Posten hette `bankid-xmldsig-adapter-missing`
   * och sa att läsaren av XML-signaturen saknades. Läsaren finns sedan 17b, och
   * klienten mot BankID sedan 17c. Kvar är att ingen riktig underskrift från BankID
   * har prövats, eftersom en sådan kräver en människa med test-BankID.
   */
  {
    id: 'bankid-reader-untested-against-bankid',
    title: 'Läsaren av BankID:s underskrift är inte prövad mot en riktig underskrift',
    why:
      'BankID lämnar underskriften som en XML-signatur, XMLDSig, med det signerade innehållet och ' +
      'certifikatkedjan inbäddade. Läsaren som prövar den är byggd efter BankID:s beskrivning av ' +
      'formatet och godtar bara exakt den strukturen och de algoritmerna. Klienten mot BankID:s ' +
      'RP-API finns, och den är prövad mot BankID:s testmiljö för att starta en legitimering, fråga ' +
      'efter den och avbryta den. Men BankID publicerar inget fullständigt exempel på en underskrift, ' +
      'och ingen underskrift från testmiljön finns bland testfallen: en sådan kräver en människa med ' +
      'test-BankID. Attrappen skriver samma format, så att varje test går genom läsaren, men det är ' +
      'attrappens tolkning av beskrivningen. Avviker en riktig underskrift från den, till exempel i ' +
      'ett elementnamn, en algoritm eller ett fält som BankID lägger till, avvisar läsaren ' +
      'underskriften, och rösten läggs inte. Läsaren kräver att srvInfo/name, den förlitande partens ' +
      'namn ur dess certifikat, är systemets eget, och att texten väljaren såg är den appen visade. ' +
      'Skarpt läge mot BankID:s testmiljö kan starta, med en varning om det här, men skarpt läge mot ' +
      'produktionen vägrar starta tills en riktig underskrift har lagts in som testfall.',
    stillTrueIf: [
      // Ingen riktig underskrift är prövad. Konstanten byts när en läggs in som testfall.
      {
        file: 'src/modules/eligibility/bankid/kind.ts',
        contains: 'export const READER_TESTED_AGAINST_REAL_SIGNATURE = false',
      },
      // Kravet stoppar produktion och varnar i testmiljön.
      { file: 'src/lib/runtime-mode.ts', contains: "blocking: bankIdEnvironment !== 'test'," },
      // Klienten finns och väljs i skarpt läge.
      {
        file: 'src/modules/eligibility/bankid/index.ts',
        contains: "runtimeMode() === 'DEMO' ? new MockBankIdService() : realBankIdService()",
      },
    ],
  },
  /** Fixrunda 1 av uppgift 17c. */
  {
    id: 'bankid-test-environment-identity-not-secured',
    title: 'Skarpt läge mot BankID:s testmiljö säkrar inte vem som röstar',
    why:
      'Med BANKID_ENV=test går legitimering och underskrift till BankID:s testmiljö, med riktiga ' +
      'BankID-flöden. Men vem som helst kan skaffa ett test-BankID för vilket personnummer som helst, och ' +
      'därmed rösta som vem som helst som står i röstlängden. Ett val i testmiljön är alltså inte ett ' +
      'riktigt val. Skarpt läge mot testmiljön får ändå starta, så att klienten och läsaren kan prövas: ' +
      'kravet att läsaren är prövad mot en riktig underskrift är där bara en varning, medan det stoppar ' +
      'produktionen. Varje sida bär då en banderoll som säger att identiteten inte är säkrad, och ' +
      'adminsidan och loggen säger detsamma. Fastställandets granskningshändelse bär BankID-miljön i sin ' +
      'typ. Omröstningen bär den BankID-miljö den skapades mot, och det publicerade resultatet och ' +
      'verktyget som prövar det visar miljön. En server mot produktionen vägrar lägga i, stänga, räkna, ' +
      'publicera och fastställa en omröstning från testmiljön. Den som kan skriva i båda databaserna kan ' +
      'ändå skriva om miljön.',
    stillTrueIf: [
      { file: 'src/lib/runtime-mode.ts', contains: "blocking: bankIdEnvironment !== 'test'," },
      { file: 'src/lib/mode-banner.ts', contains: "if (configuredBankIdEnvironment() === 'test') {" },
      // Publiceringen bär miljön ur omröstningens rad, och spärren prövar den (härdningen, punkt 3).
      {
        file: 'src/orchestration/publish-results.usecase.ts',
        contains: 'bankIdEnvironment: election.bankIdEnvironment',
      },
      {
        file: 'src/lib/election-environment.ts',
        contains: 'election.bankIdEnvironment === serverBankIdEnvironment()',
      },
    ],
  },
  /** Fixrunda 1 av uppgift 17c. */
  {
    id: 'rp-certificate-change-fails-envelopes',
    title: 'Ett RP-certifikat som byts under ett val fäller de kuvert som redan lagts',
    why:
      'Varje underskrift bär i srvInfo/name namnet ur det RP-certifikat som tjänsten hade när väljaren ' +
      'skrev under. Valideringen före stängningen jämför det med namnet ur det certifikat som ' +
      'BANKID_CERT_PATH pekar ut vid stängningen. Byts certifikatet medan röstningen pågår, till exempel ' +
      'för att det gamla går ut, och får det nya ett annat subject, underkänns varje kuvert som lagts under ' +
      'det gamla med skälet service_name, och stängningen stoppar med kopplingen kvar. Ett certifikat som ' +
      'förnyas med samma subject påverkar inte. Systemet har ingen lista över tidigare namn.',
    stillTrueIf: [
      { file: 'src/orchestration/validate-before-close.usecase.ts', contains: 'const service = expectedServiceName()' },
      {
        file: 'src/modules/eligibility/bankid/service-name.ts',
        contains: 'const name = serviceNameOf(rpCredentialsFromEnv().certificate)',
      },
    ],
  },
  {
    id: 'pepper-holder-reads-voter-names',
    title: 'Den som har pepparn kan läsa namn och personnummer för varje liggande kuvert',
    why:
      'Varje liggande kuvert bär väljarens BankID-underskrift, med certifikatet, personnumret och ' +
      'namnet i klartext, krypterad med en nyckel som härleds ur IDENTITY_PEPPER och utfylld till en ' +
      'fast längd, så att inte heller längden säger något om namnet eller banken. Nyckeln måste ' +
      'finnas hos servern, eftersom valideringen före stängningen öppnar varje underskrift. En ' +
      'databasdump utan pepparn avslöjar därför ingenting nytt om den. Underskriftens värde, ' +
      'SignatureValue, lagras däremot också för sig, som det är, och med riktig BankID följer dess ' +
      'längd lövets nyckelstorlek, som kan skilja sig mellan bankerna och alltså peka ut vem som ' +
      'utfärdat certifikatet. Den som har både databasen och pepparn öppnar varje underskrift och ' +
      'får namn och personnummer för alla som har röstat och ' +
      'ännu inte fått sitt kuvert skalat, utan en enda hashning. Det är mer än röstlängden ger i ' +
      'dag. Där går identitetshasharna visserligen också att vända med pepparn, genom att alla ' +
      'tänkbara personnummer prövas, omkring 4·10⁷ à 37 ms eller ungefär 17 processordygn, som går ' +
      'att dela upp, men namnen finns ingen annanstans i databasen. Också den som ska granska ' +
      'underskrifterna får namnen: för att pröva kedjorna mot BankID:s rot behöver granskaren ' +
      'pepparn, och får då också veta vem som röstat. I Azure ligger pepparn i Key Vault, och den ' +
      'som får läsa valvet får den. Appen får den som miljövariabel när containern startar och har ' +
      'den i minnet så länge den kör, så den som tagit sig in i appen har den också. Underskriften ' +
      'raderas med raden vid skalningen, men en säkerhetskopia från före stängningen har den kvar, och ' +
      'pepparn, som distributionen bara skriver när den saknas i valvet, öppnar den också där.',
    stillTrueIf: [
      // Kedjans nyckel härleds ur pepparn. Kom den i stället från något som
      // servern inte bär, till exempel förtroendemännens andelar, ändrades raden.
      { file: 'src/modules/eligibility/sealed-chain.ts', contains: "hkdfSync('sha256', env.identityPepper," },
      // Underskriftens värde lagras också för sig, som det är, utan försegling.
      { file: 'src/modules/eligibility/pending-vote.service.ts', contains: 'bankIdSignature: signed.signatureValue,' },
      // I Azure kommer pepparn ur valvet och blir en miljövariabel i appen.
      // Stannade den i en HSM, som räknade åt appen, ändrades raden.
      { file: 'infra/azure/app.bicep', contains: "{ name: 'IDENTITY_PEPPER', secretRef: 'identity-pepper' }" },
      // Distributionen skriver pepparn bara när den saknas i valvet, och den
      // stoppar när den inte kan avgöra om den finns. Före b0a94dc gjorde Git
      // Bash om sökvägen till hemligheten, kontrollen svarade alltid nej, och en
      // omkörning skrev över pepparn (granskningen av 11g, M3 och V2).
      { file: 'infra/azure/deploy.sh', contains: 'if secret_exists identity-pepper; then' },
      { file: 'infra/azure/deploy.sh', contains: '*) die "Kunde inte avgöra om hemligheten $1 finns: $out" ;;' },
      { file: 'infra/azure/deploy.sh', contains: 'export MSYS_NO_PATHCONV=1' },
    ],
  },
  /**
   * NY I GRANSKNINGEN AV 11g (E3).
   *
   * Azure-uppsättningen kör i demoläget, och demovalets andelar är krypterade
   * med tre fasta fraser. Posten säger vad det betyder där: lösenfraserna, som
   * spec 4.5 bygger skyddet av andelarna på, skyddar ingenting i demon.
   */
  {
    id: 'demo-trustee-passphrases-known',
    title: 'I demoläget är förtroendemännens lösenfraser kända',
    why:
      'Demovalets tre andelar är krypterade med tre fasta fraser, så att en och samma person kan ' +
      'spela alla tre förtroendemännen. Fraserna står i repot, i prisma/seed.ts, och därmed i ' +
      'imagen, där prisma kopieras in, och seedningen skriver ut dem varje gång appen startar i ' +
      'demoläget, i Azure alltså i Log Analytics. Den som når röstdatabasen, med adressen ur valvet eller som ' +
      'administratör, kan då öppna andelarna och dekryptera varje chiffer hen kommer åt, inte bara ' +
      'summan. Lösenfraserna skyddar alltså ingenting för demovalet. I skarpt läge vägrar skapandet av en ' +
      'omröstning de tre fraserna, och seedningen vägrar köra. Spärren gäller de tre fraserna i repot, ' +
      'inte svaga fraser i allmänhet, och den hänger inte på en miljövariabel. ' +
      'Omröstningen bär sitt läge och sin BankID-miljö, i båda databaserna. Ett demoval som redan finns ' +
      'kan därför inte läggas i, stängas, räknas, publiceras eller fastställas av en server i skarpt ' +
      'läge, ett skarpt val inte av en demoserver, och ett val mot BankID:s testmiljö inte av en server ' +
      'mot produktionen. Spärren gäller läggningen av kuvert, underskriftens start (sign-start), ' +
      'jämförelsen med enhetens röst (compare), stängningen, räkningens ingångar, dekrypteringen, ' +
      'omräkningen och publiceringen, fastställandet, och rutten som startar slutkontrollen. ' +
      'Demoåterställningen kräver demovalets namn, läget DEMO och miljön none i båda raderna. ' +
      'Läsvägarna spärras inte: ' +
      'adminsidans läsning av fas och antal (state), observatörens överblick (observer/election) och ' +
      'verifieringssidans besked (participation) svarar i båda lägena, eftersom de ändrar ingenting ' +
      'och bara lämnar ut antal, fas och väljarens eget besked. ' +
      'Läggningen, underskriftens start och jämförelsen läser röstlängdens rad, och stängning och fastställande kräver att båda raderna ' +
      'stämmer. Den som kan skriva i båda databaserna kan ändå byta läget och miljön, och den som läser databasen ' +
      'direkt hindras inte av något läge. Spärren skyddar alltså mot ett misstag och inte mot en sådan ' +
      'skrivning.',
    stillTrueIf: [
      // Fraserna står i seedningen ...
      { file: 'prisma/seed.ts', contains: "'demo-fortroendeman-ett'," },
      // ... som skriver ut dem vid varje körning ...
      {
        file: 'prisma/seed.ts',
        contains: 'TRUSTEE_PASSPHRASES.map((phrase, index) => `  ${index + 1}. ${phrase}`)',
      },
      // ... och körs vid varje start i demoläget, med seedningen kopierad in i imagen.
      { file: 'docker/entrypoint.sh', contains: 'npx tsx prisma/seed.ts' },
      { file: 'Dockerfile', contains: 'COPY --from=builder /app/prisma ./prisma' },
      // I skarpt läge vägrar skapandet av en omröstning fraserna, och seedningen körs inte.
      {
        file: 'src/orchestration/create-election.usecase.ts',
        contains: "input.trusteePassphrases.some(isKnownDemoPassphrase)",
      },
      { file: 'prisma/seed.ts', contains: 'assertSeedAllowed()' },
      // Omröstningens läge prövas i läggningen av kuvert, räkningen och publiceringen ...
      { file: 'src/modules/eligibility/pending-vote.service.ts', contains: 'electionBelongsToThisServer(election)' },
      { file: 'src/orchestration/tally.usecase.ts', contains: 'checkElectionMode(' },
      // ... i underskriftens start och jämförelsen, som läser röstlängdens rad som läggningen ...
      { file: 'src/app/api/vote/sign-start/route.ts', contains: "if (window === 'wrong_mode') {" },
      { file: 'src/app/api/vote/compare/route.ts', contains: "if (compared.status === 'wrong_mode') {" },
      // ... och demoåterställningen kräver läget och miljön, inte bara namnet.
      {
        file: 'src/orchestration/reset-demo-election.usecase.ts',
        contains: "row !== null && row.mode === 'DEMO' && row.bankIdEnvironment === 'none'",
      },
      { file: 'src/orchestration/publish-results.usecase.ts', contains: 'checkElectionMode(' },
      // ... och i rutten som startar slutkontrollen.
      { file: 'src/app/api/admin/elections/check/route.ts', contains: 'checkElectionMode(' },
    ],
  },
  {
    id: 'client-code-from-server',
    title: 'Klientkoden levereras av servern',
    why:
      'Rösten krypteras i din webbläsare, men koden kommer från den som ska granskas. En riktad, ' +
      'manipulerad version kan kryptera något annat än du valde, eller behålla slumptalet och ' +
      'göra det enheten visar till ett bevis som en köpare kan kräva — tyst, och utan att synas ' +
      'i databasen. Motmedlet, att väljaren kan låta granska en krypterad valsedel innan hon ' +
      'lägger den (cast-or-audit), ligger utanför specen, och problemet går inte att lösa fullt ' +
      'ut i en webbapp.',
    /**
     * Så länge valsedeln krypteras i klientkod som servern levererar står
     * problemet kvar (spec 10, klientintegriteten är fortfarande olöst).
     */
    stillTrueIf: {
      file: 'src/app/vote/page.tsx',
      contains: "import { encryptBallotInSteps } from '@/lib/encrypt-client'",
    },
  },
  {
    id: 'municipality-beside-identity-hash',
    title: 'Folkbokföringskoden ligger bredvid identitetshashen',
    why:
      'Folkbokföringsorten står i samma rad som identitetshashen. Ett personnummer är sällan ' +
      'hemligt, så den som har pepparn bekräftar en utpekad person med ett anrop och läser av ' +
      'orten — och för någon med skyddad folkbokföring är numret ofta redan känt av just den hen ' +
      'skyddas från, medan orten är det som ska vara hemlig. Ingen hashparameter hjälper mot en ' +
      'riktad kontroll. Lösningen är att inte lagra uppgiften: orten behövs bara för att välja ' +
      'kommunvalsedel och ska slås upp mot folkbokföringen vid inloggning, så att värdet lever i ' +
      'den ena begäran. Tre vägar är redan uteslutna — en egen tabell byter bara kolumnnamn ' +
      'eftersom joinet ger tillbaka kopplingen, lagrade valsedelsrättigheter avslöjar samma sak ' +
      '(rätten till Faluns kommunvalsedel ÄR kommunen), och BankID kan inte leverera den: ' +
      'completionData innehåller personnummer och namn, ingen adress.',
    stillTrueIf: { file: 'prisma/voters/schema.prisma', contains: 'municipalityCode' },
  },
  {
    id: 'commitments-internal-only',
    title: 'Kuvertroten och urnroten sparas bara av systemet självt',
    why:
      'Kuvertroten och urnroten skrivs i röstlängden och i revisionskedjan, och lämnas ut av ' +
      'observatörsrutten. En rot som bara finns i databasen som den skyddar kan skrivas om ' +
      'tillsammans med det den binder, av den som kan skriva i den. Den som sparat roten utanför ' +
      'systemet i tid ser det. Att granskare hämtar och sparar rötterna medan röstningen pågår är ' +
      'en rutin systemet inte kan genomdriva.',
    // Ingen kodmarkör: att rötterna publiceras externt är en driftsrutin, inte en kodegenskap.
  },
  {
    id: 'single-administrator',
    title: 'En ensam administratör',
    why:
      'Att öppna resultatet kräver två av tre förtroendepersoner, men att skapa och fastställa en ' +
      'omröstning gör en administratör ensam. Skapandet tar emot alla tre förtroendepersonernas ' +
      'lösenfraser i en och samma begäran, så den som skapar omröstningen och servern ser dem alla. ' +
      'Fastställandet är ett klick av en administratör, och ingen annan behöver godkänna det. Att ' +
      'skapandet och fastställandet borde kräva att flera behöriga personer agerar tillsammans är ' +
      'kvar. Resultatets öppnande kräver två andelar, men den som skapar omröstningen känner alla tre ' +
      'fraser och kan driva hela valet.',
    // Försvinner när skapandet och fastställandet kräver flera godkännanden.
    stillTrueIf: [
      {
        file: 'src/orchestration/final-check.usecase.ts',
        contains: 'export async function certifyElection',
      },
      // Alla tre fraser kommer i en och samma begäran.
      { file: 'src/lib/validation.ts', contains: 'trusteePassphrases: trusteePassphrasesSchema,' },
    ],
  },
  /**
   * Härdningen, punkt 1. Posten hette förut "står stilla på sin anslutning" och sa att
   * systemet varken skickade keepalive eller frågade låset med jämna mellanrum. Båda görs
   * nu, och det som står kvar är att låset hänger på en enda anslutning.
   */
  {
    id: 'closing-lock-connection-idles',
    title: 'Stängningens lås hänger på en enda anslutning',
    why:
      'Stängningen håller sitt lås i en egen transaktion i röstlängden, på en anslutning som inget annat ' +
      'använder medan kuverten valideras och flyttas på andra anslutningar, i ett stort val i timmar. ' +
      'Anslutningen får en lätt fråga varje minut, och servern skickar TCP keepalive efter en minut utan ' +
      'trafik, så att nätets tomgångsgränser, till exempel omkring fyra minuter för SNAT i Azure, inte ' +
      'ska kapa den. Ett test prövar frågan mot en tomgångsgräns som räknas i trafik på anslutningen. Att ' +
      'keepalive ensamt räcker mot Azures gräns är inte prövat. En tomgångsgräns under en minut, en ' +
      'omstart av databasen eller ett avbrott i nätet släpper ändå låset. Stängningen märker det vid nästa ' +
      'fråga till låset eller i skalningen, avbryts åt det säkra hållet, utan att ha raderat något och med ' +
      'det försiktiga beskedet, och kan köras om. Låsets transaktion har dessutom en egen tidsgräns på sex ' +
      'timmar, och en stängning som tar längre tid går inte att genomföra.',
    stillTrueIf: [
      // Låsets transaktion står stilla med avsikt, och databasens tomgångsgräns stängs av för den.
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: "await tx.$queryRaw`SELECT set_config('idle_in_transaction_session_timeout', '0', true)`",
      },
      // Hjärtslaget en gång i minuten, och serverns keepalive efter en minut.
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'export const closingLockHeartbeat = { intervalMs: 60_000 }',
      },
      { file: 'src/orchestration/close-election.usecase.ts', contains: "set_config('tcp_keepalives_idle', '60', true)" },
      // Låsets egen tidsgräns.
      {
        file: 'src/orchestration/close-election.usecase.ts',
        contains: 'const CLOSING_LOCK_TIMEOUT_MS = 6 * 60 * 60 * 1000',
      },
    ],
  },
  {
    id: 'admission-queue-per-process',
    title: 'Nummerlappen gäller bara en serverinstans',
    why:
      'Antagningskön som skyddar den minneshårda identitetshashningen håller sitt tillstånd i ' +
      'processminnet. Två följder: med flera instanser bakom en lastbalanserare blir det faktiska ' +
      'taket åtta gånger antalet instanser, alltså inte det tak minnesberäkningen utgår från. Och ' +
      'köplatsen är inte en riktig nummerlapp — den lever bara så länge begäran lever, så en ' +
      'väljare som tappar nätet eller vars begäran tar timeout hamnar sist igen. En valdag behöver ' +
      'delad kö med bestående platser, så att den som väntat längst behåller sin plats i kön.',
    stillTrueIf: {
      file: 'src/lib/admission-queue.ts',
      contains: 'const waiting: Waiter[] = []',
    },
  },
  {
    id: 'order-state-per-process',
    title: 'Orderns tillstånd under signeringen hålls i en serverprocess',
    why:
      'Mellan att väljaren startar underskriften och att BankID är klart håller servern den ' +
      'krypterade valsedeln i processminnet, bunden till väljarens session, och den förfaller efter ' +
      'tre minuter. Är verifieringskön full när BankID svarar klart håller servern också ' +
      'BankID:s svar, tills nästa pollning kan lägga rösten. Det svaret innehåller väljarens ' +
      'personnummer och namn i klartext, i certifikatkedjan, och ligger i processminnet i upp till ' +
      'tre minuter. Den som kan läsa processminnet läser dem där. Med flera instanser bakom en lastbalanserare kan en pollning hamna hos en ' +
      'instans som inte har ordern, och väljaren får skriva under igen. Detsamma gäller om servern ' +
      'startas om under en signering. Verifieringskön, som prövar bevisen i valsedeln, är per ' +
      'process på samma sätt.',
    stillTrueIf: [
      {
        file: 'src/lib/order-state.ts',
        contains: 'const orders: Map<string, Entry> = globalForOrders.__orderStates',
      },
      { file: 'src/lib/order-state.ts', contains: 'export function attachCompletion(' },
    ],
  },
]

/** Begränsningar som går att kontrollera automatiskt. */
export const CHECKABLE_LIMITATIONS = KNOWN_LIMITATIONS.filter(
  (limitation) => limitation.stillTrueIf !== undefined,
)
