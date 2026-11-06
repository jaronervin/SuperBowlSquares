// Football squares fundraiser — Cloudflare Worker + D1.
//
// Roles:
//   public  – anyone with the link: boards, names (first name + last initial),
//             drawn numbers, scores, winners. Nothing about money.
//   helper  – HELPER_PIN: hold squares, record paid sales.
//   admin   – ADMIN_PIN: everything, including money, refunds, number draw.

import { parseEspn } from './espn.js';
import { schemaStatements, UPGRADES } from './schema.js';

const PUBLIC_CONFIG = ['title', 'subtitle', 'top_name', 'side_name', 'prize_text'];
const ADMIN_CONFIG = [
  'title', 'subtitle', 'top_name', 'top_abbr', 'side_name', 'side_abbr', 'game_date',
  'price_cents', 'hold_minutes', 'venmo_user', 'prize_text', 'sales_open',
];
const METHODS = ['venmo', 'cash', 'zelle', 'other'];
const SESSION_HOURS = 16;
const SCORE_CACHE_MS = 30_000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      await ensureSchema(env);
      return await route(request, env, url);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message, ...err.extra }, err.status);
      console.error(err);
      return json({ error: 'Something went wrong on the server.' }, 500);
    }
  },
};

// Create the tables on a brand-new database. Checked once per worker instance.
let schemaReady = false;
async function ensureSchema(env) {
  if (schemaReady) return;
  const found = await env.DB.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'login_failures'",
  ).first();
  if (!found) await env.DB.batch(schemaStatements().map((q) => env.DB.prepare(q)));
  for (const u of UPGRADES) {
    const added = await env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, '1')")
      .bind(u.marker)
      .run();
    if (added.meta.changes === 1) await env.DB.prepare(u.sql).run();
  }
  schemaReady = true;
}

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function route(request, env, url) {
  const path = url.pathname.slice(4); // strip "/api"
  const method = request.method;

  if (method === 'GET' && path === '/public') return publicState(env, url);
  if (method === 'POST' && path === '/login') return login(request, env);

  const session = await authenticate(request, env);
  const body = method === 'POST' ? await readJson(request) : null;

  if (method === 'GET' && path === '/state') return helperState(env, url, session);
  if (method === 'POST' && path === '/hold') return hold(env, body, session);
  if (method === 'POST' && path === '/release') return release(env, body);
  if (method === 'POST' && path === '/extend') return extend(env, body);
  if (method === 'POST' && path === '/sell') return sell(env, body, session, url);

  if (session.role !== 'admin') throw new HttpError(403, 'Admin passcode required.');
  if (method === 'GET' && path === '/admin') return adminState(env);
  if (method === 'POST' && path === '/admin/config') return setConfig(env, body);
  if (method === 'POST' && path === '/admin/board/new') return newBoardRoute(env);
  if (method === 'POST' && path === '/admin/board/draw') return drawBoard(env, body);
  if (method === 'POST' && path === '/admin/board/refund') return refundBoard(env, body);
  if (method === 'POST' && path === '/admin/board/reopen') return reopenBoard(env, body);
  if (method === 'POST' && path === '/admin/board/delete') return deleteBoard(env, body);
  if (method === 'POST' && path === '/admin/refund') return markRefund(env, body);
  if (method === 'POST' && path === '/admin/prize') return markPrize(env, body);
  if (method === 'POST' && path === '/admin/score') return setScore(env, body);
  if (method === 'POST' && path === '/admin/refresh-scores') return refreshScores(env);
  if (method === 'POST' && path === '/admin/sale/void') return voidSale(env, body);

  throw new HttpError(404, 'Not found.');
}

// ---------------------------------------------------------------- helpers

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, 'Bad request.');
  }
}

const now = () => Date.now();

async function getConfig(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM config').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function getVersion(env) {
  const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'version'").first();
  return Number(row?.value || 0);
}

function bumpStmt(env) {
  return env.DB.prepare(
    "UPDATE config SET value = CAST(value AS INTEGER) + 1 WHERE key = 'version'",
  );
}

async function bump(env) {
  await bumpStmt(env).run();
}

// "Jaron Ervin" -> "Jaron E."
function shortName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

function randomToken(bytes = 12) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Unbiased Fisher–Yates shuffle of 0–9 using the platform's secure RNG.
function shuffledDigits() {
  const d = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
  for (let i = d.length - 1; i > 0; i--) {
    const limit = 256 - (256 % (i + 1));
    let r;
    do r = crypto.getRandomValues(new Uint8Array(1))[0];
    while (r >= limit);
    const j = r % (i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function int(v, name) {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `Invalid ${name}.`);
  return n;
}

// ---------------------------------------------------------------- auth

const enc = new TextEncoder();

async function hmacKey(env) {
  const material = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`squares|${env.HELPER_PIN}|${env.ADMIN_PIN}`),
  );
  return crypto.subtle.importKey('raw', material, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

const b64u = (buf) =>
  btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
const unb64u = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function login(request, env) {
  if (!env.HELPER_PIN || !env.ADMIN_PIN) {
    throw new HttpError(500, 'HELPER_PIN and ADMIN_PIN have not been set up yet.');
  }
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const fail = await env.DB.prepare('SELECT count, first_at FROM login_failures WHERE ip = ?')
    .bind(ip)
    .first();
  const windowMs = 15 * 60_000;
  if (fail && fail.count >= 10 && now() - fail.first_at < windowMs) {
    throw new HttpError(429, 'Too many wrong passcodes. Wait 15 minutes and try again.');
  }

  const { pin, name } = await readJson(request);
  const helperName = String(name || '').trim().slice(0, 40);
  if (!helperName) throw new HttpError(400, 'Enter your name.');

  let role = null;
  if (safeEqual(pin, env.ADMIN_PIN)) role = 'admin';
  else if (safeEqual(pin, env.HELPER_PIN)) role = 'helper';

  if (!role) {
    if (!fail || now() - fail.first_at >= windowMs) {
      await env.DB.prepare(
        'INSERT OR REPLACE INTO login_failures (ip, count, first_at) VALUES (?, 1, ?)',
      )
        .bind(ip, now())
        .run();
    } else {
      await env.DB.prepare('UPDATE login_failures SET count = count + 1 WHERE ip = ?')
        .bind(ip)
        .run();
    }
    throw new HttpError(401, 'Wrong passcode.');
  }
  if (fail) await env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();

  const payload = b64u(
    enc.encode(JSON.stringify({ r: role, n: helperName, e: now() + SESSION_HOURS * 3600_000 })),
  );
  const sig = b64u(await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(payload)));
  return json({ token: `${payload}.${sig}`, role, name: helperName });
}

async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.');
  if (!payload || !sig || !env.HELPER_PIN || !env.ADMIN_PIN) {
    throw new HttpError(401, 'Please sign in.');
  }
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64u(sig), enc.encode(payload));
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'Please sign in again.');
  const data = JSON.parse(new TextDecoder().decode(unb64u(payload)));
  if (data.e < now()) throw new HttpError(401, 'Your sign-in expired. Please sign in again.');
  return { role: data.r, name: data.n };
}

// ---------------------------------------------------------------- boards

async function newBoard(env) {
  const created = await env.DB.prepare(
    "INSERT INTO boards (status, created_at) VALUES ('open', ?) RETURNING id",
  )
    .bind(now())
    .first();
  await env.DB.batch([
    env.DB.prepare(
      `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < 99)
       INSERT INTO squares (board_id, idx) SELECT ?, i FROM n`,
    ).bind(created.id),
    bumpStmt(env),
  ]);
  return created.id;
}

// After a sale: if every open board is full, open the next one.
async function ensureOpenBoard(env) {
  const cfg = await getConfig(env);
  if (cfg.sales_open !== '1') return null;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS free FROM squares s JOIN boards b ON b.id = s.board_id
     WHERE b.status = 'open' AND s.status != 'sold'`,
  ).first();
  if (row.free > 0) return null;
  return newBoard(env);
}

async function boardsWithSquares(env, where) {
  const { results: boards } = await env.DB.prepare(
    `SELECT id, status, col_digits, row_digits, drawn_at FROM boards ${where} ORDER BY id`,
  ).all();
  if (boards.length === 0) return [];
  const ids = boards.map((b) => b.id);
  const { results: squares } = await env.DB.prepare(
    `SELECT s.board_id, s.idx, s.status, s.hold_cart, s.hold_helper, s.hold_until,
            sa.buyer_name, sa.token
     FROM squares s LEFT JOIN sales sa ON sa.id = s.sale_id
     WHERE s.board_id IN (${ids.map(() => '?').join(',')})
     ORDER BY s.board_id, s.idx`,
  )
    .bind(...ids)
    .all();
  const byBoard = new Map(boards.map((b) => [b.id, []]));
  for (const sq of squares) byBoard.get(sq.board_id).push(sq);
  return boards.map((b) => ({
    id: b.id,
    status: b.status,
    cols: b.col_digits ? JSON.parse(b.col_digits) : null,
    rows: b.row_digits ? JSON.parse(b.row_digits) : null,
    drawn_at: b.drawn_at,
    squares: byBoard.get(b.id),
  }));
}

// ---------------------------------------------------------------- public

async function publicState(env, url) {
  const v = await getVersion(env);
  const scores = await getScores(env, false);
  const me = url.searchParams.get('me');
  if (url.searchParams.get('v') === String(v) && !url.searchParams.has('full')) {
    return json({ v, same: true, scores });
  }

  const cfg = await getConfig(env);
  const boards = await boardsWithSquares(env, "WHERE status IN ('open', 'drawn', 'refund')");
  let mine = null;
  let meName = null;
  if (me) {
    const sale = await env.DB.prepare('SELECT buyer_name FROM sales WHERE token = ?')
      .bind(me)
      .first();
    if (sale) {
      // A buyer may have bought more than once; match on all their sales by name+contact.
      const { results } = await env.DB.prepare(
        `SELECT s.board_id, s.idx FROM squares s JOIN sales sa ON sa.id = s.sale_id
         WHERE sa.token = ? OR (sa.buyer_name, sa.contact) =
           (SELECT buyer_name, contact FROM sales WHERE token = ?)`,
      )
        .bind(me, me)
        .all();
      mine = results.map((r) => [r.board_id, r.idx]);
      meName = shortName(sale.buyer_name);
    }
  }

  return json({
    v,
    config: Object.fromEntries(PUBLIC_CONFIG.map((k) => [k, cfg[k]])),
    boards: boards.map((b) => ({
      id: b.id,
      status: b.status,
      cols: b.cols,
      rows: b.rows,
      drawn_at: b.drawn_at,
      names: b.squares.map((s) => (s.status === 'sold' ? shortName(s.buyer_name) : null)),
    })),
    scores,
    mine,
    meName,
  });
}

// ---------------------------------------------------------------- helper

async function helperState(env, url, session) {
  const v = await getVersion(env);
  if (url.searchParams.get('v') === String(v)) return json({ v, same: true, t: now() });
  const cart = url.searchParams.get('cart') || '';
  const cfg = await getConfig(env);
  const boards = await boardsWithSquares(env, "WHERE status = 'open'");
  return json({
    v,
    t: now(), // server time, so tablets with a wrong clock still show the right countdown
    me: session,
    config: {
      title: cfg.title,
      top_name: cfg.top_name,
      side_name: cfg.side_name,
      price_cents: Number(cfg.price_cents),
      hold_minutes: Number(cfg.hold_minutes),
      venmo_user: cfg.venmo_user,
      sales_open: cfg.sales_open === '1',
    },
    boards: boards.map((b) => ({
      id: b.id,
      squares: b.squares.map((s) => {
        if (s.status === 'sold') return { s: 'sold', n: shortName(s.buyer_name) };
        if (s.status === 'held' && s.hold_until > now()) {
          return s.hold_cart === cart
            ? { s: 'mine', u: s.hold_until }
            : { s: 'held', n: s.hold_helper, u: s.hold_until };
        }
        return { s: 'open' };
      }),
    })),
  });
}

function cartId(body) {
  const cart = String(body?.cart || '');
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(cart)) throw new HttpError(400, 'Bad cart.');
  return cart;
}

async function hold(env, body, session) {
  const cart = cartId(body);
  const board = int(body.board, 'board');
  const idx = int(body.idx, 'square');
  if (idx < 0 || idx > 99) throw new HttpError(400, 'Invalid square.');
  const cfg = await getConfig(env);
  if (cfg.sales_open !== '1') throw new HttpError(409, 'Sales are closed.');
  const t = now();
  const until = t + Number(cfg.hold_minutes || 3) * 60_000;

  // One statement, so two helpers tapping the same square can't both get it.
  const res = await env.DB.prepare(
    `UPDATE squares SET status = 'held', hold_cart = ?1, hold_helper = ?2, hold_until = ?3
     WHERE board_id = ?4 AND idx = ?5
       AND (status = 'open' OR (status = 'held' AND (hold_until < ?6 OR hold_cart = ?1)))
       AND board_id IN (SELECT id FROM boards WHERE status = 'open')`,
  )
    .bind(cart, session.name, until, board, idx, t)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'Someone else just took that square.');

  // Picking a square restarts the clock on everything in this cart.
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE squares SET hold_until = ? WHERE hold_cart = ? AND status = 'held'",
    ).bind(until, cart),
    bumpStmt(env),
  ]);
  return json({ ok: true, until });
}

async function release(env, body) {
  const cart = cartId(body);
  const clear = `status = 'open', hold_cart = NULL, hold_helper = NULL, hold_until = NULL`;
  let stmt;
  if (body.board != null && body.idx != null) {
    stmt = env.DB.prepare(
      `UPDATE squares SET ${clear} WHERE hold_cart = ? AND status = 'held' AND board_id = ? AND idx = ?`,
    ).bind(cart, int(body.board, 'board'), int(body.idx, 'square'));
  } else {
    stmt = env.DB.prepare(`UPDATE squares SET ${clear} WHERE hold_cart = ? AND status = 'held'`).bind(
      cart,
    );
  }
  await env.DB.batch([stmt, bumpStmt(env)]);
  return json({ ok: true });
}

async function extend(env, body) {
  const cart = cartId(body);
  const cfg = await getConfig(env);
  const t = now();
  const until = t + Number(cfg.hold_minutes || 3) * 60_000;
  // Only squares this cart still holds (an expired hold nobody else took counts).
  const res = await env.DB.prepare(
    "UPDATE squares SET hold_until = ? WHERE hold_cart = ? AND status = 'held'",
  )
    .bind(until, cart)
    .run();
  await bump(env);
  return json({ ok: true, until, count: res.meta.changes });
}

async function sell(env, body, session, url) {
  const cart = cartId(body);
  const buyerName = String(body.buyer_name || '').trim().slice(0, 60);
  const contact = String(body.contact || '').trim().slice(0, 80);
  const method = String(body.method || '');
  const note = String(body.note || '').trim().slice(0, 200);
  const expect = Array.isArray(body.expect) ? body.expect : [];
  if (!buyerName) throw new HttpError(400, "Enter the buyer's name.");
  if (!contact) throw new HttpError(400, 'Enter a phone number or email so we can reach a winner.');
  if (!METHODS.includes(method)) throw new HttpError(400, 'Choose how they paid.');
  if (expect.length === 0) throw new HttpError(400, 'No squares selected.');

  const cfg = await getConfig(env);
  if (cfg.sales_open !== '1') throw new HttpError(409, 'Sales are closed.');

  const { results: held } = await env.DB.prepare(
    "SELECT board_id, idx FROM squares WHERE hold_cart = ? AND status = 'held'",
  )
    .bind(cart)
    .all();
  const key = (b, i) => `${b}:${i}`;
  const heldSet = new Set(held.map((r) => key(r.board_id, r.idx)));
  const expectSet = new Set(expect.map(([b, i]) => key(b, i)));
  const lost = [...expectSet].filter((k) => !heldSet.has(k));
  if (lost.length || heldSet.size !== expectSet.size) {
    throw new HttpError(409, 'Some squares in this order were taken by someone else.', {
      lost: lost.map((k) => k.split(':').map(Number)),
    });
  }

  const token = randomToken();
  const unit = Number(cfg.price_cents);
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sales (token, buyer_name, contact, method, unit_cents, square_count, helper, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(token, buyerName, contact, method, unit, expectSet.size, session.name, note || null, now()),
    env.DB.prepare(
      `UPDATE squares SET status = 'sold', sale_id = (SELECT id FROM sales WHERE token = ?),
              hold_cart = NULL, hold_helper = NULL, hold_until = NULL
       WHERE hold_cart = ? AND status = 'held'`,
    ).bind(token, cart),
    bumpStmt(env),
  ]);

  // If another helper grabbed an expired square in the split second between the
  // check and the update, undo the whole sale rather than charge for fewer squares.
  if (results[1].meta.changes !== expectSet.size) {
    const until = now() + Number(cfg.hold_minutes || 3) * 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE squares SET status = 'held', hold_cart = ?, hold_helper = ?, hold_until = ?, sale_id = NULL
         WHERE sale_id = (SELECT id FROM sales WHERE token = ?)`,
      ).bind(cart, session.name, until, token),
      env.DB.prepare('DELETE FROM sales WHERE token = ?').bind(token),
      bumpStmt(env),
    ]);
    throw new HttpError(409, 'Some squares in this order were taken by someone else. Try again.');
  }

  await ensureOpenBoard(env);
  return json({
    ok: true,
    token,
    link: `${url.origin}/?me=${token}`,
    count: expectSet.size,
    amount_cents: unit * expectSet.size,
  });
}

// ---------------------------------------------------------------- scores

function inGameWindow(gameDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate || '')) return false;
  const start = Date.parse(`${gameDate}T12:00:00Z`);
  return now() >= start && now() <= start + 24 * 3600_000; // noon UTC to noon UTC next day
}

async function fetchEspn(cfg) {
  const ymd = cfg.game_date.replace(/-/g, '');
  const res = await fetch(
    `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${ymd}`,
    { headers: { accept: 'application/json' } },
  );
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return parseEspn(await res.json(), cfg);
}

async function getScores(env, force) {
  const cfg = await getConfig(env);
  let cache = null;
  try {
    cache = cfg.live_cache ? JSON.parse(cfg.live_cache) : null;
  } catch {
    cache = null;
  }
  const configured = cfg.top_abbr && cfg.side_abbr && cfg.game_date;
  const stale = !cache || now() - cache.fetched_at > SCORE_CACHE_MS;
  // Once the game is over, stop asking ESPN.
  const finished = cache?.live?.state === 'post';
  if (configured && stale && (force || (inGameWindow(cfg.game_date) && !finished))) {
    try {
      cache = { ...(await fetchEspn(cfg)), fetched_at: now(), error: null };
    } catch (err) {
      cache = { ...(cache || {}), fetched_at: now(), error: String(err.message || err) };
    }
    await env.DB.prepare("UPDATE config SET value = ? WHERE key = 'live_cache'")
      .bind(JSON.stringify(cache))
      .run();
  }

  const { results: overrides } = await env.DB.prepare(
    'SELECT quarter, top, side FROM score_overrides',
  ).all();
  const byQ = new Map(overrides.map((o) => [o.quarter, o]));
  const quarters = [1, 2, 3, 4].map((q) => {
    const o = byQ.get(q);
    if (o) return { q, top: o.top, side: o.side, done: true, source: 'manual' };
    return cache?.quarters?.[q - 1] || { q, done: false };
  });
  return {
    quarters,
    live: cache?.live || null,
    fetched_at: cache?.fetched_at || null,
    error: cache?.error || null,
  };
}

// The winning square on a drawn board for a finished quarter.
function winningIdx(board, qScore) {
  if (!board.cols || !board.rows || !qScore?.done) return null;
  const col = board.cols.indexOf(qScore.top % 10);
  const row = board.rows.indexOf(qScore.side % 10);
  return row * 10 + col;
}

// ---------------------------------------------------------------- admin

async function adminState(env) {
  const cfg = await getConfig(env);
  const scores = await getScores(env, false);
  const boards = await boardsWithSquares(env, '');
  const { results: sales } = await env.DB.prepare('SELECT * FROM sales ORDER BY id DESC').all();
  const { results: refunds } = await env.DB.prepare('SELECT * FROM refunds').all();
  const { results: prizes } = await env.DB.prepare('SELECT * FROM prizes').all();
  const { results: overrides } = await env.DB.prepare('SELECT * FROM score_overrides').all();

  const salesById = new Map(sales.map((s) => [s.id, { ...s, squares: [] }]));
  const salesByToken = new Map([...salesById.values()].map((s) => [s.token, s]));
  for (const b of boards) {
    for (const sq of b.squares) {
      if (sq.status === 'sold') salesByToken.get(sq.token)?.squares.push([b.id, sq.idx]);
    }
  }

  const refunded = new Set(refunds.map((r) => `${r.sale_id}:${r.board_id}`));
  const refundsOwed = [];
  for (const b of boards.filter((x) => x.status === 'refund')) {
    const perSale = new Map();
    for (const sq of b.squares) {
      if (sq.status !== 'sold') continue;
      const sale = salesByToken.get(sq.token);
      perSale.set(sale.id, (perSale.get(sale.id) || 0) + 1);
    }
    for (const [saleId, count] of perSale) {
      const s = salesById.get(saleId);
      refundsOwed.push({
        sale_id: saleId,
        board_id: b.id,
        buyer_name: s.buyer_name,
        contact: s.contact,
        method: s.method,
        squares: count,
        amount_cents: count * s.unit_cents,
        done: refunded.has(`${saleId}:${b.id}`),
      });
    }
  }

  const delivered = new Set(prizes.map((p) => `${p.board_id}:${p.quarter}`));
  const winners = [];
  for (const b of boards.filter((x) => x.status === 'drawn')) {
    for (const qs of scores.quarters) {
      const idx = winningIdx(b, qs);
      if (idx == null) continue;
      const sale = salesByToken.get(b.squares[idx].token);
      winners.push({
        board_id: b.id,
        quarter: qs.q,
        idx,
        score: `${qs.top}–${qs.side}`,
        buyer_name: sale?.buyer_name,
        contact: sale?.contact,
        delivered: delivered.has(`${b.id}:${qs.q}`),
      });
    }
  }

  const totals = { by_method: {}, collected_cents: 0, squares: 0, refunds_owed_cents: 0, refunded_cents: 0 };
  for (const s of sales) {
    const amt = s.unit_cents * s.square_count;
    totals.collected_cents += amt;
    totals.squares += s.square_count;
    totals.by_method[s.method] = (totals.by_method[s.method] || 0) + amt;
  }
  for (const r of refundsOwed) {
    if (r.done) totals.refunded_cents += r.amount_cents;
    else totals.refunds_owed_cents += r.amount_cents;
  }

  return json({
    config: Object.fromEntries(ADMIN_CONFIG.map((k) => [k, cfg[k]])),
    boards: boards.map((b) => ({
      id: b.id,
      status: b.status,
      cols: b.cols,
      rows: b.rows,
      drawn_at: b.drawn_at,
      sold: b.squares.filter((s) => s.status === 'sold').length,
      held: b.squares.filter((s) => s.status === 'held' && s.hold_until > now()).length,
    })),
    sales: [...salesById.values()],
    refunds: refundsOwed,
    winners,
    scores,
    overrides,
    totals,
  });
}

async function setConfig(env, body) {
  const stmts = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!ADMIN_CONFIG.includes(k)) continue;
    let value = String(v ?? '').trim();
    if (k === 'price_cents' || k === 'hold_minutes') {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${k}.`);
    }
    if (k === 'sales_open') value = value === '1' || value === 'true' ? '1' : '0';
    if (k === 'game_date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new HttpError(400, 'Game date must look like 2027-02-14.');
    }
    if (k === 'top_abbr' || k === 'side_abbr') value = value.toUpperCase();
    stmts.push(env.DB.prepare('UPDATE config SET value = ? WHERE key = ?').bind(value, k));
  }
  // Changing teams or the date means the cached ESPN result no longer applies.
  if (['top_abbr', 'side_abbr', 'game_date'].some((k) => k in (body || {}))) {
    stmts.push(env.DB.prepare("UPDATE config SET value = '' WHERE key = 'live_cache'"));
  }
  // Closing sales lets go of anything still held.
  if (body?.sales_open !== undefined && !(body.sales_open === '1' || body.sales_open === true)) {
    stmts.push(
      env.DB.prepare(
        `UPDATE squares SET status = 'open', hold_cart = NULL, hold_helper = NULL, hold_until = NULL
         WHERE status = 'held'`,
      ),
    );
  }
  stmts.push(bumpStmt(env));
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function newBoardRoute(env) {
  const id = await newBoard(env);
  return json({ ok: true, id });
}

async function drawBoard(env, body) {
  const id = int(body.board, 'board');
  const board = await env.DB.prepare('SELECT status FROM boards WHERE id = ?').bind(id).first();
  if (!board) throw new HttpError(404, 'No such board.');
  if (board.status === 'drawn') throw new HttpError(409, 'Numbers were already drawn for this board.');
  const sold = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM squares WHERE board_id = ? AND status = 'sold'",
  )
    .bind(id)
    .first();
  if (sold.n !== 100) {
    throw new HttpError(409, `Board ${id} has only ${sold.n} of 100 squares sold. Only full boards get numbers.`);
  }
  const cols = shuffledDigits();
  const rows = shuffledDigits();
  const res = await env.DB.prepare(
    `UPDATE boards SET status = 'drawn', col_digits = ?, row_digits = ?, drawn_at = ?
     WHERE id = ? AND status != 'drawn'`,
  )
    .bind(JSON.stringify(cols), JSON.stringify(rows), now(), id)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'Numbers were already drawn for this board.');
  await bump(env);
  return json({ ok: true, cols, rows });
}

async function refundBoard(env, body) {
  const id = int(body.board, 'board');
  const res = await env.DB.prepare(
    "UPDATE boards SET status = 'refund' WHERE id = ? AND status = 'open'",
  )
    .bind(id)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'Only an open board can be marked for refund.');
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE squares SET status = 'open', hold_cart = NULL, hold_helper = NULL, hold_until = NULL
       WHERE board_id = ? AND status = 'held'`,
    ).bind(id),
    bumpStmt(env),
  ]);
  return json({ ok: true });
}

// Permanently remove a board, its squares, and the sales (or the part of a
// sale) on it. The caller must send confirm: "DELETE <id>", typed by the admin.
async function deleteBoard(env, body) {
  const id = int(body.board, 'board');
  if (String(body.confirm || '').trim().toUpperCase() !== `DELETE ${id}`) {
    throw new HttpError(400, `To delete Board ${id}, type DELETE ${id} exactly.`);
  }
  const board = await env.DB.prepare('SELECT id FROM boards WHERE id = ?').bind(id).first();
  if (!board) throw new HttpError(404, 'No such board.');
  await env.DB.batch([
    // Sales with squares on other boards too keep those squares; only this
    // board's part comes off their count (and so off the totals).
    env.DB.prepare(
      `UPDATE sales SET square_count = square_count -
         (SELECT COUNT(*) FROM squares WHERE squares.sale_id = sales.id AND squares.board_id = ?1)
       WHERE id IN (SELECT sale_id FROM squares WHERE board_id = ?1 AND sale_id IS NOT NULL)`,
    ).bind(id),
    env.DB.prepare('DELETE FROM squares WHERE board_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sales WHERE square_count <= 0'),
    env.DB.prepare('DELETE FROM refunds WHERE board_id = ?').bind(id),
    env.DB.prepare('DELETE FROM prizes WHERE board_id = ?').bind(id),
    env.DB.prepare('DELETE FROM boards WHERE id = ?').bind(id),
    bumpStmt(env),
  ]);
  await ensureOpenBoard(env);
  return json({ ok: true });
}

async function reopenBoard(env, body) {
  const id = int(body.board, 'board');
  const done = await env.DB.prepare('SELECT COUNT(*) AS n FROM refunds WHERE board_id = ?')
    .bind(id)
    .first();
  if (done.n > 0) throw new HttpError(409, 'Refunds were already marked paid on this board.');
  const res = await env.DB.prepare(
    "UPDATE boards SET status = 'open' WHERE id = ? AND status = 'refund'",
  )
    .bind(id)
    .run();
  if (res.meta.changes !== 1) throw new HttpError(409, 'That board is not marked for refund.');
  await bump(env);
  return json({ ok: true });
}

async function markRefund(env, body) {
  const sale = int(body.sale, 'sale');
  const board = int(body.board, 'board');
  if (body.done) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO refunds (sale_id, board_id, done_at) VALUES (?, ?, ?)',
    )
      .bind(sale, board, now())
      .run();
  } else {
    await env.DB.prepare('DELETE FROM refunds WHERE sale_id = ? AND board_id = ?')
      .bind(sale, board)
      .run();
  }
  return json({ ok: true });
}

async function markPrize(env, body) {
  const board = int(body.board, 'board');
  const quarter = int(body.quarter, 'quarter');
  if (body.done) {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO prizes (board_id, quarter, delivered_at) VALUES (?, ?, ?)',
    )
      .bind(board, quarter, now())
      .run();
  } else {
    await env.DB.prepare('DELETE FROM prizes WHERE board_id = ? AND quarter = ?')
      .bind(board, quarter)
      .run();
  }
  return json({ ok: true });
}

async function setScore(env, body) {
  const q = int(body.quarter, 'quarter');
  if (q < 1 || q > 4) throw new HttpError(400, 'Quarter must be 1–4.');
  if (body.clear) {
    await env.DB.prepare('DELETE FROM score_overrides WHERE quarter = ?').bind(q).run();
  } else {
    const top = int(body.top, 'score');
    const side = int(body.side, 'score');
    if (top < 0 || side < 0) throw new HttpError(400, 'Scores can’t be negative.');
    await env.DB.prepare(
      'INSERT OR REPLACE INTO score_overrides (quarter, top, side) VALUES (?, ?, ?)',
    )
      .bind(q, top, side)
      .run();
  }
  await bump(env);
  return json({ ok: true });
}

async function refreshScores(env) {
  const cfg = await getConfig(env);
  if (!(cfg.top_abbr && cfg.side_abbr && cfg.game_date)) {
    throw new HttpError(400, 'Set both team abbreviations and the game date first.');
  }
  await env.DB.prepare("UPDATE config SET value = '' WHERE key = 'live_cache'").run();
  const scores = await getScores(env, true);
  await bump(env);
  return json({ ok: true, scores });
}

async function voidSale(env, body) {
  const id = int(body.sale, 'sale');
  const drawn = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM squares s JOIN boards b ON b.id = s.board_id
     WHERE s.sale_id = ? AND b.status = 'drawn'`,
  )
    .bind(id)
    .first();
  if (drawn.n > 0) throw new HttpError(409, 'Numbers are already drawn on a board in this sale.');
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE squares SET status = 'open', sale_id = NULL WHERE sale_id = ?",
    ).bind(id),
    env.DB.prepare('DELETE FROM refunds WHERE sale_id = ?').bind(id),
    env.DB.prepare('DELETE FROM sales WHERE id = ?').bind(id),
    bumpStmt(env),
  ]);
  return json({ ok: true });
}
