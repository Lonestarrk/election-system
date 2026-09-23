/*
  Warnings:

  - You are about to drop the column `bankid_certificate` on the `pending_vote` table. All the data in the column will be lost.
  - Added the required column `bankid_public_key` to the `pending_vote` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "pending_vote" DROP COLUMN "bankid_certificate",
ADD COLUMN     "bankid_public_key" TEXT NOT NULL;
