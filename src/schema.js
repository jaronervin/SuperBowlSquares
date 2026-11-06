// Database tables. The worker runs this automatically the first time it
// handles a request, so a new deployment needs no manual database setup.
// Every statement is safe to run again on an existing database.

export const SCHEMA_SQL = `
-- Settings the admin can change from the admin screen.
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES
  ('title',          'Super Bowl Squares'),
  ('subtitle',       'Fundraiser'),
  ('top_name',       'AFC'),     -- team across the top (columns)
  ('top_abbr',       ''),        -- ESPN abbreviation, e.g. KC, for live scores
  ('side_name',      'NFC'),     -- team down the side (rows)
  ('side_abbr',      ''),
  ('game_date',      '2027-02-14'), -- YYYY-MM-DD, for live scores (Super Bowl LXI)
  ('price_cents',    '500'),
  ('hold_minutes',   '3'),
  ('venmo_user',     ''),
  ('prize_text',     'Each quarter''s winner on every board gets a gift basket.'),
  ('sales_open',     '1'),
  ('version',        '1'),       -- bumped on every change so screens know to refresh
  ('live_cache',     '');        -- last ESPN result (JSON)

-- One 10x10 board. Square idx = row * 10 + col.
-- status: open (selling) | drawn (numbers assigned) | refund (didn't fill, refunding)
CREATE TABLE IF NOT EXISTS boards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  status     TEXT NOT NULL DEFAULT 'open',
  col_digits TEXT,              -- JSON array of 10 digits for the top team
  row_digits TEXT,              -- JSON array of 10 digits for the side team
  drawn_at   INTEGER,
  created_at INTEGER NOT NULL
);

-- status: open | held (a helper has it in their cart) | sold
CREATE TABLE IF NOT EXISTS squares (
  board_id    INTEGER NOT NULL REFERENCES boards(id),
  idx         INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  hold_cart   TEXT,
  hold_helper TEXT,
  hold_until  INTEGER,
  sale_id     INTEGER REFERENCES sales(id),
  PRIMARY KEY (board_id, idx)
);
CREATE INDEX IF NOT EXISTS squares_cart ON squares (hold_cart);
CREATE INDEX IF NOT EXISTS squares_sale ON squares (sale_id);

-- One purchase at the table. Money amounts are in cents.
CREATE TABLE IF NOT EXISTS sales (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token        TEXT NOT NULL UNIQUE,  -- private link token for the buyer
  buyer_name   TEXT NOT NULL,
  contact      TEXT NOT NULL,
  method       TEXT NOT NULL,         -- venmo | cash | zelle | other
  unit_cents   INTEGER NOT NULL,
  square_count INTEGER NOT NULL,
  helper       TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL
);

-- Refunds paid back for squares on boards that didn't fill.
CREATE TABLE IF NOT EXISTS refunds (
  sale_id  INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  done_at  INTEGER NOT NULL,
  PRIMARY KEY (sale_id, board_id)
);

-- Gift basket delivered to a winner.
CREATE TABLE IF NOT EXISTS prizes (
  board_id     INTEGER NOT NULL,
  quarter      INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, quarter)
);

-- Manual score overrides (cumulative score at the end of each quarter).
CREATE TABLE IF NOT EXISTS score_overrides (
  quarter INTEGER PRIMARY KEY,
  top     INTEGER NOT NULL,
  side    INTEGER NOT NULL
);

-- Failed passcode attempts, for slowing down guessing.
CREATE TABLE IF NOT EXISTS login_failures (
  ip       TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);

-- Start with Board 1.
INSERT OR IGNORE INTO boards (id, status, created_at) VALUES (1, 'open', 0);
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
INSERT OR IGNORE INTO squares (board_id, idx) SELECT 1, i FROM n;
`;

export function schemaStatements() {
  return SCHEMA_SQL.split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// One-time changes for databases created by an earlier version. Each runs once:
// its marker row is inserted first, and the change only applies if that insert
// was new.
export const UPGRADES = [
  {
    marker: 'upgrade_game_date_2027',
    sql: "UPDATE config SET value = '2027-02-14' WHERE key = 'game_date' AND value = ''",
  },
];
