CREATE TABLE letter_retention_queue (
  letter_id TEXT PRIMARY KEY REFERENCES letters(id) ON DELETE CASCADE,
  content_delete_at INTEGER NOT NULL
);
CREATE INDEX idx_letter_retention_queue_deadline ON letter_retention_queue(content_delete_at);
