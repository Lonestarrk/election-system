-- Uppgift 17: omröstningen bär sitt läge.
--
-- DEMO eller SHARP, det läge omröstningen skapades i. En server i skarpt läge
-- vägrar läggning, stängning och fastställande i en DEMO-omröstning, och
-- tvärtom, så att demoröster aldrig hamnar i ett skarpt val och en
-- demoomröstning aldrig kan fastställas som riktig.
--
-- Omröstningar som redan finns är skapade före lägesväxeln, och alla databaser
-- som finns är demodatabaser. De får därför DEMO. Förvalet gäller bara raderna
-- som finns när kolumnen läggs till: skapandet i appen skriver alltid läget
-- uttryckligen, ur serverns eget läge.

-- AlterTable
ALTER TABLE "election" ADD COLUMN     "mode" TEXT NOT NULL DEFAULT 'DEMO';
