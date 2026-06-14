CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED');
ALTER TABLE "protocols"
  ADD COLUMN "verification_status" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
  ADD COLUMN "verified_at" TIMESTAMPTZ,
  ADD COLUMN "verification_note" TEXT;
