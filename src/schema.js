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
  ('online_open',    '0'),       -- buyers can pick and reserve squares at /buy
  ('online_max',     '20'),      -- most squares in one online order
  ('reserve_minutes','30'),      -- online order must be marked paid within this
  ('confirm_hours',  '24'),      -- ...then confirmed by the admin within this
  ('org_name',       ''),        -- e.g. "GHEMS PTA"
  ('contact',        ''),        -- shown wherever the site says "contact the organizers"
  ('about_text',     ''),        -- short blurb on the public page
  ('color_main',     '#1d4f91'),
  ('color_accent',   '#f5b700'),
  ('logo_ver',       '0'),       -- bumped when the logo changes (0 = no logo)
  ('setup_done',     '0'),       -- first-run setup wizard finished
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
  created_at   INTEGER NOT NULL,
  -- confirmed (counts as sold) | reserved (online, not paid yet)
  -- | pending (online, buyer says paid) | rejected | expired
  status       TEXT NOT NULL DEFAULT 'confirmed',
  source       TEXT NOT NULL DEFAULT 'helper',   -- helper | online
  code         TEXT,                             -- short order code for the Venmo note
  expires_at   INTEGER,                          -- reserved/pending orders lapse after this
  paid_at      INTEGER,                          -- when the buyer tapped "I've paid"
  confirmed_at INTEGER,
  ip           TEXT                              -- hashed, to limit online orders per person
);
CREATE INDEX IF NOT EXISTS sales_status ON sales (status, expires_at);

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

-- Passcode hashes and the sign-in key. Kept out of the config table so they
-- never travel with settings.
CREATE TABLE IF NOT EXISTS auth (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Uploaded images: the logo (shown in headers) and the home-screen icon.
CREATE TABLE IF NOT EXISTS assets (
  name       TEXT PRIMARY KEY,
  mime       TEXT NOT NULL,
  data       TEXT NOT NULL,     -- base64
  updated_at INTEGER NOT NULL
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
    sql: ["UPDATE config SET value = '2027-02-14' WHERE key = 'game_date' AND value = ''"],
  },
  {
    marker: 'upgrade_online_orders',
    sql: [
      "ALTER TABLE sales ADD COLUMN status TEXT NOT NULL DEFAULT 'confirmed'",
      "ALTER TABLE sales ADD COLUMN source TEXT NOT NULL DEFAULT 'helper'",
      'ALTER TABLE sales ADD COLUMN code TEXT',
      'ALTER TABLE sales ADD COLUMN expires_at INTEGER',
      'ALTER TABLE sales ADD COLUMN paid_at INTEGER',
      'ALTER TABLE sales ADD COLUMN confirmed_at INTEGER',
      'ALTER TABLE sales ADD COLUMN ip TEXT',
      'CREATE INDEX IF NOT EXISTS sales_status ON sales (status, expires_at)',
      "INSERT OR IGNORE INTO config (key, value) VALUES ('online_open', '0'), ('online_max', '20'), ('reserve_minutes', '30'), ('confirm_hours', '24')",
    ],
  },
  {
    marker: 'upgrade_auth_table',
    sql: ['CREATE TABLE IF NOT EXISTS auth (key TEXT PRIMARY KEY, value TEXT NOT NULL)'],
  },
  {
    marker: 'upgrade_branding',
    sql: [
      'CREATE TABLE IF NOT EXISTS assets (name TEXT PRIMARY KEY, mime TEXT NOT NULL, data TEXT NOT NULL, updated_at INTEGER NOT NULL)',
      "INSERT OR IGNORE INTO config (key, value) VALUES ('org_name', ''), ('contact', ''), ('about_text', ''), ('color_main', '#1d4f91'), ('color_accent', '#f5b700'), ('logo_ver', '0'), ('setup_done', '0')",
    ],
  },
];
