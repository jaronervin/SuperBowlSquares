-- Settings the admin can change from the admin screen.
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('title',          'Super Bowl Squares'),
  ('subtitle',       'Fundraiser'),
  ('top_name',       'AFC'),     -- team across the top (columns)
  ('top_abbr',       ''),        -- ESPN abbreviation, e.g. KC, for live scores
  ('side_name',      'NFC'),     -- team down the side (rows)
  ('side_abbr',      ''),
  ('game_date',      ''),        -- YYYY-MM-DD, for live scores
  ('price_cents',    '500'),
  ('hold_minutes',   '3'),
  ('venmo_user',     ''),
  ('prize_text',     'Each quarter''s winner on every board gets a gift basket.'),
  ('sales_open',     '1'),
  ('version',        '1'),       -- bumped on every change so screens know to refresh
  ('live_cache',     '');        -- last ESPN result (JSON)

-- One 10x10 board. Square idx = row * 10 + col.
-- status: open (selling) | drawn (numbers assigned) | refund (didn't fill, refunding)
CREATE TABLE boards (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  status     TEXT NOT NULL DEFAULT 'open',
  col_digits TEXT,              -- JSON array of 10 digits for the top team
  row_digits TEXT,              -- JSON array of 10 digits for the side team
  drawn_at   INTEGER,
  created_at INTEGER NOT NULL
);

-- status: open | held (a helper has it in their cart) | sold
CREATE TABLE squares (
  board_id    INTEGER NOT NULL REFERENCES boards(id),
  idx         INTEGER NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open',
  hold_cart   TEXT,
  hold_helper TEXT,
  hold_until  INTEGER,
  sale_id     INTEGER REFERENCES sales(id),
  PRIMARY KEY (board_id, idx)
);
CREATE INDEX squares_cart ON squares (hold_cart);
CREATE INDEX squares_sale ON squares (sale_id);

-- One purchase at the table. Money amounts are in cents.
CREATE TABLE sales (
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
CREATE TABLE refunds (
  sale_id  INTEGER NOT NULL,
  board_id INTEGER NOT NULL,
  done_at  INTEGER NOT NULL,
  PRIMARY KEY (sale_id, board_id)
);

-- Gift basket delivered to a winner.
CREATE TABLE prizes (
  board_id     INTEGER NOT NULL,
  quarter      INTEGER NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (board_id, quarter)
);

-- Manual score overrides (cumulative score at the end of each quarter).
CREATE TABLE score_overrides (
  quarter INTEGER PRIMARY KEY,
  top     INTEGER NOT NULL,
  side    INTEGER NOT NULL
);

-- Failed passcode attempts, for slowing down guessing.
CREATE TABLE login_failures (
  ip       TEXT PRIMARY KEY,
  count    INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);

-- Start with Board 1.
INSERT INTO boards (status, created_at) VALUES ('open', 0);
WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
INSERT INTO squares (board_id, idx) SELECT 1, i FROM n;
