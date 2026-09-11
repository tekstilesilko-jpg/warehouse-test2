PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('WAREHOUSE','SALES','ADMIN')),
  language TEXT NOT NULL DEFAULT 'lt',
  is_active INTEGER NOT NULL DEFAULT 1,
  notification_enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL,
  canonical_unit TEXT NOT NULL DEFAULT 'm',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS product_identifier_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  alias TEXT NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(alias),
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS stock_balances (
  product_id INTEGER PRIMARY KEY,
  on_hand TEXT NOT NULL DEFAULT '0',
  reserved TEXT NOT NULL DEFAULT '0',
  quality_hold TEXT NOT NULL DEFAULT '0',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS source_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  external_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  file_version INTEGER NOT NULL DEFAULT 1,
  payload_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(channel, external_id, file_version)
);

CREATE TABLE IF NOT EXISTS review_drafts (
  id TEXT PRIMARY KEY,
  draft_type TEXT NOT NULL CHECK (draft_type IN ('SUPPLIER_RECEIPT','CLIENT_INVOICE','CLIENT_CREDIT')),
  status TEXT NOT NULL DEFAULT 'PENDING',
  source_document_id INTEGER,
  source_ref TEXT,
  counterpart_name TEXT,
  document_number TEXT,
  issue_date TEXT,
  currency TEXT DEFAULT 'EUR',
  total_amount TEXT DEFAULT '0',
  created_by INTEGER,
  reviewer_id INTEGER,
  approved_snapshot TEXT,
  approved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_document_id) REFERENCES source_documents(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reviewer_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS review_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL,
  line_no INTEGER NOT NULL,
  printed_product_id TEXT,
  printed_description TEXT,
  printed_quantity TEXT,
  printed_unit TEXT,
  printed_unit_price TEXT,
  printed_currency TEXT,
  source_evidence TEXT,
  extraction_confidence REAL DEFAULT 0,
  interpretation TEXT NOT NULL,
  interpreted_product_id TEXT,
  interpreted_quantity TEXT,
  interpreted_unit TEXT,
  interpreted_unit_price TEXT,
  interpreted_currency TEXT,
  edited_product_id TEXT,
  edited_description TEXT,
  edited_quantity TEXT,
  edited_unit TEXT,
  edited_unit_price TEXT,
  edited_currency TEXT,
  matched_product_id INTEGER,
  match_status TEXT NOT NULL DEFAULT 'UNRESOLVED',
  requires_human_action INTEGER NOT NULL DEFAULT 0,
  is_stock_line INTEGER NOT NULL DEFAULT 1,
  warning_json TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (draft_id) REFERENCES review_drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  draft_id TEXT NOT NULL,
  reservation_type TEXT NOT NULL DEFAULT 'CLIENT_INVOICE',
  quantity TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  FOREIGN KEY (draft_id) REFERENCES review_drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS quality_holds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  draft_id TEXT NOT NULL,
  quantity TEXT NOT NULL DEFAULT '0',
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  FOREIGN KEY (draft_id) REFERENCES review_drafts(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL,
  movement_type TEXT NOT NULL,
  quantity TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'm',
  unit_price TEXT,
  currency TEXT,
  source_draft_id TEXT NOT NULL,
  actor_user_id INTEGER,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  outbox_state TEXT NOT NULL DEFAULT 'PENDING',
  outbox_payload TEXT,
  FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE RESTRICT,
  FOREIGN KEY (source_draft_id) REFERENCES review_drafts(id) ON DELETE RESTRICT,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS approval_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT NOT NULL UNIQUE,
  approver_id INTEGER NOT NULL,
  approval_type TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (draft_id) REFERENCES review_drafts(id) ON DELETE RESTRICT,
  FOREIGN KEY (approver_id) REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_user_id INTEGER,
  actor_email TEXT,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT,
  details_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  draft_id TEXT,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_review_drafts_status ON review_drafts(status);
CREATE INDEX IF NOT EXISTS idx_review_lines_draft ON review_lines(draft_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_draft ON stock_movements(source_draft_id);
