-- Uppgift 11e: BankID-ordern bär ett åtagande, inte chifferhashen.
--
-- Det väljaren skriver under i BankID bär SHA-256 över chifferhashen och ett
-- salt, och saltet ligger bara här. Det raderas med raden vid skalningen, och
-- efter det går BankID:s kopia av det signerade inte att matcha mot hashen i
-- urnan.
--
-- Kolumnen får vara NULL, eftersom kuvert som lades före ändringen saknar salt.
-- De är underskrivna över chifferhashen, och valideringen före stängningen
-- underkänner dem som OLD_SIGNATURE_FORMAT. Inget kuvert skrivs om här:
-- underskriften går inte att göra om utan väljaren.

-- AlterTable
ALTER TABLE "pending_vote" ADD COLUMN     "commitment_salt" TEXT;
