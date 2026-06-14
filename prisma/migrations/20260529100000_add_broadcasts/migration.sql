-- CreateTable: broadcast_messages + protocol_broadcast_receipts
-- Enables Herald admins to send announcements to protocol owners.

CREATE TABLE "broadcast_messages" (
  "id"          UUID          NOT NULL DEFAULT gen_random_uuid(),
  "title"       VARCHAR(200)  NOT NULL,
  "body"        TEXT          NOT NULL,
  "type"        VARCHAR(30)   NOT NULL,
  "target_mode" VARCHAR(20)   NOT NULL,
  "target_tier" SMALLINT,
  "target_ids"  TEXT[]        NOT NULL DEFAULT ARRAY[]::TEXT[],
  "sent_count"  INTEGER       NOT NULL DEFAULT 0,
  "sent_by"     VARCHAR(100),
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "broadcast_messages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_broadcasts_created" ON "broadcast_messages"("created_at" DESC);

CREATE TABLE "protocol_broadcast_receipts" (
  "id"           UUID          NOT NULL DEFAULT gen_random_uuid(),
  "broadcast_id" UUID          NOT NULL,
  "protocol_id"  UUID          NOT NULL,
  "email_sent"   BOOLEAN       NOT NULL DEFAULT false,
  "read_at"      TIMESTAMPTZ(6),
  "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),

  CONSTRAINT "protocol_broadcast_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "protocol_broadcast_receipts_broadcast_id_fkey"
    FOREIGN KEY ("broadcast_id") REFERENCES "broadcast_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "protocol_broadcast_receipts_protocol_id_fkey"
    FOREIGN KEY ("protocol_id") REFERENCES "protocols"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "protocol_broadcast_receipts_broadcast_id_protocol_id_key"
    UNIQUE ("broadcast_id", "protocol_id")
);

CREATE INDEX "idx_broadcast_receipts_protocol" ON "protocol_broadcast_receipts"("protocol_id", "read_at");
