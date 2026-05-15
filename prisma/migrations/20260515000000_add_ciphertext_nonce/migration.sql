-- Add ciphertext and nonce columns for E2EE notification body storage
-- ciphertext: NaCl box ciphertext of the notification body (hex-encoded)
-- nonce: NaCl box nonce (24 bytes, hex-encoded = 48 chars)

ALTER TABLE "notifications" ADD COLUMN "ciphertext" TEXT;
ALTER TABLE "notifications" ADD COLUMN "nonce" VARCHAR(48);
