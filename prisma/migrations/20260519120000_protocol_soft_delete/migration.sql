-- Add soft-delete support to protocols
ALTER TABLE protocols ADD COLUMN deleted_at TIMESTAMPTZ;

-- Index so listing active protocols (WHERE deleted_at IS NULL) stays fast
CREATE INDEX idx_protocols_deleted_at ON protocols (deleted_at) WHERE deleted_at IS NOT NULL;
