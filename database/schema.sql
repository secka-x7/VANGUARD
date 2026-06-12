CREATE TABLE IF NOT EXISTS borrowers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  protocol TEXT NOT NULL DEFAULT 'aave',
  health_factor REAL DEFAULT 999,
  collateral_usd REAL DEFAULT 0,
  debt_usd REAL DEFAULT 0,
  last_checked INTEGER DEFAULT (strftime('%s','now')),
  UNIQUE(address, chain, protocol)
);
CREATE TABLE IF NOT EXISTS executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tx_hash TEXT,
  chain TEXT,
  protocol TEXT DEFAULT 'aave',
  borrower TEXT,
  collateral_asset TEXT,
  debt_asset TEXT,
  profit_usdc REAL DEFAULT 0,
  gas_usdc REAL DEFAULT 0,
  status TEXT DEFAULT 'pending',
  error_msg TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS withdrawals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idempotency_key TEXT UNIQUE,
  usdc_amount REAL,
  gmd_amount REAL,
  transfer_id TEXT,
  status TEXT DEFAULT 'pending',
  error TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS system_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE TABLE IF NOT EXISTS apex_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subsystem TEXT,
  action TEXT,
  result TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS idx_b_hf ON borrowers(health_factor);
CREATE INDEX IF NOT EXISTS idx_b_chain ON borrowers(chain, protocol);
CREATE INDEX IF NOT EXISTS idx_e_status ON executions(status);
CREATE INDEX IF NOT EXISTS idx_e_chain ON executions(chain, protocol);
CREATE INDEX IF NOT EXISTS idx_e_created ON executions(created_at);
