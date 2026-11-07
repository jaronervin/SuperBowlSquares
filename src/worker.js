// Football squares fundraiser — Cloudflare Worker + D1.
//
// Roles:
//   public  – anyone with the link: boards, names (first name + last initial),
//             drawn numbers, scores, winners. Nothing about money.
//   helper  – HELPER_PIN: hold squares, record paid sales.
//   admin   – ADMIN_PIN: everything, including money, refunds, number draw.

import { parseEspn, listGames } from './espn.js';
import { sendEmail, emailReady, fromLine, paidNotice, confirmedEmail, testEmail, isEmail } from './email.js';
import { schemaStatements, UPGRADES } from './schema.js';
import { themeCss, validColor, initials, DEFAULT_MAIN, DEFAULT_ACCENT } from '../public/theme.js';

const PUBLIC_CONFIG = ['title', 'subtitle', 'top_name', 'side_name', 'prize_text', 'org_name', 'contact', 'about_text', 'logo_ver'];
const ADMIN_CONFIG = [
  'title', 'subtitle', 'top_name', 'top_abbr', 'side_name', 'side_abbr', 'game_date',
  'price_cents', 'hold_minutes', 'venmo_user', 'cashapp_tag', 'paypal_id', 'prize_text', 'sales_open',
  'online_open', 'online_max', 'reserve_minutes', 'confirm_hours',
  'org_name', 'contact', 'about_text', 'color_main', 'color_accent', 'setup_done', 'logo_ver',
  'notify_email',
];
const NUMERIC_CONFIG = ['price_cents', 'hold_minutes', 'online_max', 'reserve_minutes', 'confirm_hours'];
const ONLINE_BUYER = 'Online buyer';
const METHODS = ['cashapp', 'venmo', 'paypal', 'cash', 'zelle', 'other'];
const PAY_APPS = ['cashapp', 'venmo', 'paypal'];
// The payment accounts set up, as sent to the sign-up table and buyers' order pages.
const payConfig = (cfg) => ({ cashapp_tag: cfg.cashapp_tag || '', venmo_user: cfg.venmo_user || '', paypal_id: cfg.paypal_id || '' });

// Accept what people paste ("$Tag", "@user", "https://paypal.me/name") and keep just the name.
function payHandle(k, raw) {
  let v = String(raw || '').trim();
  if (!v) return '';
  if (k === 'cashapp_tag') {
    v = v.replace(/^https?:\/\/(www\.)?cash\.app\//i, '').replace(/^\$/, '').split(/[/?#]/)[0];
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(v)) throw new HttpError(400, 'A Cash App $cashtag looks like $FriendsofGHEMS.');
  } else if (k === 'venmo_user') {
    v = v.replace(/^https?:\/\/(www\.)?venmo\.com\/(u\/)?/i, '').replace(/^@/, '').split(/[/?#]/)[0];
    if (!/^[A-Za-z0-9_-]{1,40}$/.test(v)) throw new HttpError(400, 'A Venmo username looks like @GHEMS-PTA.');
  } else if (k === 'paypal_id') {
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v;
    v = v.replace(/^https?:\/\/(www\.)?paypal\.(me|com\/paypalme)\//i, '').replace(/^paypal\.me\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    if (!/^[A-Za-z0-9_.-]{1,40}$/.test(v)) throw new HttpError(400, 'For PayPal, use a PayPal.me link (paypal.me/YourName) or the account’s email.');
  }
  return v;
}
const SESSION_HOURS = 16;
const SCORE_CACHE_MS = 30_000;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    try {
      if (!url.pathname.startsWith('/api/')) {
        // Pages carry each group's current name, colors and logo, so never let the
        // browser reuse an old copy ("not modified" answers would skip the branding).
        const headers = new Headers(request.headers);
        headers.delete('if-none-match');
        headers.delete('if-modified-since');
        const res = await env.ASSETS.fetch(new Request(request, { headers }));
        if (!(res.headers.get('content-type') || '').includes('text/html')) return res;
        await ensureSchema(env);
        return brandPage(res, env, url);
      }
      await ensureSchema(env);
      return await route(request, env, url, ctx);
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
  const mark = (m) => env.DB.prepare("INSERT OR IGNORE INTO config (key, value) VALUES (?, '1')").bind(m);
  if (!found) {
    // A brand-new database already has every upgrade built in.
    await env.DB.batch([
      ...schemaStatements().map((q) => env.DB.prepare(q)),
      ...UPGRADES.map((u) => mark(u.marker)),
    ]);
  }
  for (const u of UPGRADES) {
    const added = await mark(u.marker).run();
    if (added.meta.changes === 1) await env.DB.batch(u.sql.map((q) => env.DB.prepare(q)));
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

async function route(request, env, url, ctx) {
  const path = url.pathname.slice(4); // strip "/api"
  const method = request.method;

  await sweepExpired(env);
  if (method === 'GET' && path === '/logo') return logoImage(env, 'logo');
  if (method === 'GET' && path === '/icon') return logoImage(env, 'icon');
  if (method === 'GET' && path === '/manifest') return manifest(env);
  if (method === 'GET' && path === '/public') return publicState(env, url);
  if (method === 'POST' && path === '/login') return login(request, env);
  if (method === 'GET' && path === '/setup') return setupStatus(env);
  if (method === 'POST' && path === '/setup/claim') return claimSite(request, env);

  // Online buyers: no sign-in.
  if (path.startsWith('/buy/')) {
    if (method === 'GET' && path === '/buy/state') return buyState(env, url);
    const b = method === 'POST' ? await readJson(request) : null;
    if (method === 'POST' && path === '/buy/hold') return hold(env, b, { name: ONLINE_BUYER }, true);
    if (method === 'POST' && path === '/buy/release') return release(env, b);
    if (method === 'POST' && path === '/buy/extend') return extend(env, b);
    if (method === 'POST' && path === '/buy/order') return reserveOnline(env, b, request, url);
    if (method === 'POST' && path === '/buy/paid') return markPaid(env, b, url, ctx);
    if (method === 'POST' && path === '/buy/cancel') return cancelOnline(env, b);
    throw new HttpError(404, 'Not found.');
  }

  const session = await authenticate(request, env);
  const body = method === 'POST' ? await readJson(request) : null;

  if (method === 'GET' && path === '/state') return helperState(env, url, session);
  if (method === 'POST' && path === '/hold') return hold(env, body, session);
  if (method === 'POST' && path === '/release') return release(env, body);
  if (method === 'POST' && path === '/extend') return extend(env, body);
  if (method === 'POST' && path === '/sell') return sell(env, body, session, url);

  if (session.role !== 'admin') throw new HttpError(403, 'Admin passcode required.');
  if (method === 'GET' && path === '/admin') return adminState(env, url);
  if (method === 'POST' && path === '/admin/config') return setConfig(env, body);
  if (method === 'POST' && path === '/admin/board/new') return newBoardRoute(env);
  if (method === 'POST' && path === '/admin/board/draw') return drawBoard(env, body);
  if (method === 'POST' && path === '/admin/board/refund') return refundBoard(env, body);
  if (method === 'POST' && path === '/admin/board/reopen') return reopenBoard(env, body);
  if (method === 'POST' && path === '/admin/board/delete') return deleteBoard(env, body);
  if (method === 'POST' && path === '/admin/new-year') return startNewYear(env, body);
  if (method === 'POST' && path === '/admin/refund') return markRefund(env, body);
  if (method === 'POST' && path === '/admin/prize') return markPrize(env, body);
  if (method === 'POST' && path === '/admin/score') return setScore(env, body);
  if (method === 'POST' && path === '/admin/refresh-scores') return refreshScores(env);
  if (method === 'GET' && path === '/admin/espn-games') return espnGames(env, url);
  if (method === 'POST' && path === '/admin/sale/void') return voidSale(env, body);
  if (method === 'POST' && path === '/admin/order/confirm') return confirmOrder(env, body, url, ctx);
  if (method === 'POST' && path === '/admin/email/test') return sendTestEmail(env, url);
  if (method === 'POST' && path === '/admin/order/reject') return rejectOrder(env, body);
  if (method === 'POST' && path === '/admin/passcode') return changePasscode(env, body, session);
  if (method === 'POST' && path === '/admin/logo') return saveLogo(env, body);
  if (method === 'POST' && path === '/admin/logo/delete') return deleteLogo(env);

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
//
// Passcodes live hashed in the auth table, so admins can change them from the
// admin page. Until one is set there, the ADMIN_PIN / HELPER_PIN secrets from
// Cloudflare are used (how the first site was set up). A brand-new site has
// neither: its admin claims it with the one-time SETUP_CODE secret and picks
// both passcodes. Sign-ins carry a per-role version, so changing the helper
// passcode signs out helpers only, and changing the admin one signs out admins.

const enc = new TextEncoder();
const MIN_PASSCODE = 6;

async function authGet(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM auth').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

async function sessionKey(env) {
  let a = await authGet(env);
  if (!a.session_key) {
    const k = b64u(crypto.getRandomValues(new Uint8Array(32)));
    await env.DB.prepare("INSERT OR IGNORE INTO auth (key, value) VALUES ('session_key', ?)").bind(k).run();
    a = await authGet(env);
  }
  return crypto.subtle.importKey('raw', unb64u(a.session_key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

async function pbkdf2(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

async function hashPasscode(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 100_000; // the most Workers allow
  return `pbkdf2$${iterations}$${b64u(salt)}$${b64u(await pbkdf2(pin, salt, iterations))}`;
}

async function checkPasscode(pin, stored) {
  const [kind, iter, salt, hash] = String(stored).split('$');
  if (kind !== 'pbkdf2') return false;
  const got = await pbkdf2(pin, unb64u(salt), Number(iter));
  return safeEqual(b64u(got), hash);
}

// Which role (if any) a typed passcode belongs to.
async function roleFor(env, a, pin) {
  if (!pin) return null;
  if (a.admin_hash ? await checkPasscode(pin, a.admin_hash) : env.ADMIN_PIN && safeEqual(pin, env.ADMIN_PIN)) return 'admin';
  if (a.helper_hash ? await checkPasscode(pin, a.helper_hash) : env.HELPER_PIN && safeEqual(pin, env.HELPER_PIN)) return 'helper';
  return null;
}

const isSetUp = (env, a) => Boolean(a.admin_hash || env.ADMIN_PIN);

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

// Slow down guessing: 10 wrong tries from one network locks it out for 15 minutes.
const FAIL_WINDOW = 15 * 60_000;
async function guardFailures(env, request) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const fail = await env.DB.prepare('SELECT count, first_at FROM login_failures WHERE ip = ?').bind(ip).first();
  if (fail && fail.count >= 10 && now() - fail.first_at < FAIL_WINDOW) {
    throw new HttpError(429, 'Too many wrong tries. Wait 15 minutes and try again.');
  }
  return {
    async failed() {
      if (!fail || now() - fail.first_at >= FAIL_WINDOW) {
        await env.DB.prepare('INSERT OR REPLACE INTO login_failures (ip, count, first_at) VALUES (?, 1, ?)').bind(ip, now()).run();
      } else {
        await env.DB.prepare('UPDATE login_failures SET count = count + 1 WHERE ip = ?').bind(ip).run();
      }
    },
    async ok() {
      if (fail) await env.DB.prepare('DELETE FROM login_failures WHERE ip = ?').bind(ip).run();
    },
  };
}

async function issueToken(env, a, role, name) {
  const v = Number(a[`${role}_ver`] || 0);
  const payload = b64u(enc.encode(JSON.stringify({ r: role, n: name, v, e: now() + SESSION_HOURS * 3600_000 })));
  const sig = b64u(await crypto.subtle.sign('HMAC', await sessionKey(env), enc.encode(payload)));
  return `${payload}.${sig}`;
}

async function login(request, env) {
  const a = await authGet(env);
  if (!isSetUp(env, a)) throw new HttpError(409, 'This site hasn’t been set up yet.', { needs_setup: true });
  const guard = await guardFailures(env, request);
  const { pin, name } = await readJson(request);
  const helperName = String(name || '').trim().slice(0, 40);
  if (!helperName) throw new HttpError(400, 'Enter your name.');
  const role = await roleFor(env, a, pin);
  if (!role) {
    await guard.failed();
    throw new HttpError(401, 'Wrong passcode.');
  }
  await guard.ok();
  return json({ token: await issueToken(env, a, role, helperName), role, name: helperName });
}

async function authenticate(request, env) {
  const header = request.headers.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new HttpError(401, 'Please sign in.');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await sessionKey(env), unb64u(sig), enc.encode(payload));
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, 'Please sign in again.');
  const data = JSON.parse(new TextDecoder().decode(unb64u(payload)));
  if (data.e < now()) throw new HttpError(401, 'Your sign-in expired. Please sign in again.');
  const a = await authGet(env);
  if (Number(data.v || 0) !== Number(a[`${data.r}_ver`] || 0)) {
    throw new HttpError(401, 'The passcode changed. Please sign in again.');
  }
  return { role: data.r, name: data.n };
}

function validPasscode(pin, label) {
  const p = String(pin || '');
  if (p.length < MIN_PASSCODE) throw new HttpError(400, `The ${label} passcode needs at least ${MIN_PASSCODE} characters.`);
  if (p.length > 100) throw new HttpError(400, `The ${label} passcode is too long.`);
  return p;
}

// New site: whether it still needs claiming.
async function setupStatus(env) {
  const a = await authGet(env);
  return json({ needs_setup: !isSetUp(env, a), has_setup_code: Boolean(env.SETUP_CODE) });
}

// New site: the admin enters the one-time setup code and picks both passcodes.
async function claimSite(request, env) {
  const a = await authGet(env);
  if (isSetUp(env, a)) throw new HttpError(409, 'This site is already set up. Sign in instead.');
  if (!env.SETUP_CODE) throw new HttpError(409, 'This site has no setup code yet. Ask the person who created it.');
  const guard = await guardFailures(env, request);
  const body = await readJson(request);
  if (!safeEqual(String(body.code || '').trim(), env.SETUP_CODE)) {
    await guard.failed();
    throw new HttpError(401, 'That setup code isn’t right.');
  }
  const name = String(body.name || '').trim().slice(0, 40);
  if (!name) throw new HttpError(400, 'Enter your name.');
  const adminPin = validPasscode(body.admin_pin, 'admin');
  const helperPin = validPasscode(body.helper_pin, 'helper');
  if (adminPin === helperPin) throw new HttpError(400, 'Use different passcodes for admins and helpers.');
  await guard.ok();
  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO auth (key, value) VALUES ('admin_hash', ?)").bind(await hashPasscode(adminPin)),
    env.DB.prepare("INSERT OR REPLACE INTO auth (key, value) VALUES ('helper_hash', ?)").bind(await hashPasscode(helperPin)),
  ]);
  const fresh = await authGet(env);
  return json({ token: await issueToken(env, fresh, 'admin', name), role: 'admin', name });
}

// Admin page: change the admin passcode (needs the current one) or the helper passcode.
async function changePasscode(env, body, session) {
  const role = body.role === 'admin' ? 'admin' : body.role === 'helper' ? 'helper' : null;
  if (!role) throw new HttpError(400, 'Choose which passcode to change.');
  const a = await authGet(env);
  if (role === 'admin' && (await roleFor(env, a, body.current)) !== 'admin') {
    throw new HttpError(401, 'Your current admin passcode isn’t right.');
  }
  const pin = validPasscode(body.new, role);
  const other = await roleFor(env, a, pin);
  if (other && other !== role) throw new HttpError(400, 'Use different passcodes for admins and helpers.');
  await env.DB.batch([
    env.DB.prepare('INSERT OR REPLACE INTO auth (key, value) VALUES (?, ?)').bind(`${role}_hash`, await hashPasscode(pin)),
    env.DB.prepare('INSERT OR REPLACE INTO auth (key, value) VALUES (?, ?)').bind(`${role}_ver`, String(Number(a[`${role}_ver`] || 0) + 1)),
  ]);
  // Changing the admin passcode signs everyone out as admin, including you: hand back a fresh sign-in.
  const fresh = await authGet(env);
  return json({ ok: true, token: role === 'admin' ? await issueToken(env, fresh, 'admin', session.name) : null });
}

// ---------------------------------------------------------------- boards

// New boards take the lowest unused number, so numbers start again at 1 once
// old boards are deleted (e.g. reusing the site next year). The number is
// picked inside the INSERT itself, so two boards created at once can't clash.
async function newBoard(env) {
  const created = await env.DB.prepare(
    `INSERT INTO boards (id, status, created_at)
     SELECT CASE
       WHEN NOT EXISTS (SELECT 1 FROM boards WHERE id = 1) THEN 1
       ELSE (SELECT MIN(b.id) + 1 FROM boards b
             WHERE NOT EXISTS (SELECT 1 FROM boards c WHERE c.id = b.id + 1))
     END, 'open', ?
     RETURNING id`,
  )
    .bind(now())
    .first();
  await env.DB.batch([
    // Clear anything left behind under this number by an older board.
    env.DB.prepare('DELETE FROM squares WHERE board_id = ?').bind(created.id),
    env.DB.prepare('DELETE FROM refunds WHERE board_id = ?').bind(created.id),
    env.DB.prepare('DELETE FROM prizes WHERE board_id = ?').bind(created.id),
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
     WHERE b.status = 'open' AND s.status NOT IN ('sold', 'pending')`,
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
            sa.buyer_name, sa.token, sa.status AS sale_status
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

// ---------------------------------------------------------------- emails

// The address emails come from: <subdomain>@<domain> of the site
// (ghems.corkandpin.com sends as ghems@corkandpin.com). None on workers.dev.
// email_from overrides it, but isn't on the admin page on purpose: it has to be an
// address at a domain verified in Resend, or every email fails. Set it directly in
// the database if a group ever needs a different address.
function senderFor(cfg, url) {
  if (cfg.email_from) return cfg.email_from;
  const parts = url.hostname.split('.');
  if (parts.length < 3 || url.hostname.endsWith('workers.dev')) return null;
  return `${parts[0]}@${parts.slice(-2).join('.')}`;
}

async function orderForEmail(env, by, value) {
  const o = await env.DB.prepare(
    `SELECT id, token, code, buyer_name, contact, method, unit_cents, square_count FROM sales WHERE ${by === 'id' ? 'id' : 'token'} = ?`,
  )
    .bind(value)
    .first();
  if (!o) return null;
  const { results } = await env.DB.prepare('SELECT board_id, idx FROM squares WHERE sale_id = ? ORDER BY board_id, idx').bind(o.id).all();
  return { ...o, amount_cents: o.unit_cents * o.square_count, squares: results.map((r) => [r.board_id, r.idx]) };
}

async function notifyPaid(env, cfg, token, origin) {
  const from = senderFor(cfg, new URL(origin));
  if (!cfg.notify_email || !from || !emailReady(env)) return;
  const order = await orderForEmail(env, 'token', token);
  if (!order) return;
  const msg = paidNotice(cfg, order, origin);
  const r = await sendEmail(env, {
    ...msg,
    from: fromLine({ ...cfg, email_from: from }),
    to: cfg.notify_email,
    replyTo: isEmail(order.contact) ? order.contact : undefined,
  });
  if (!r.ok) console.error('payment notice email failed:', r.error);
}

async function emailBuyer(env, cfg, order, url) {
  const msg = confirmedEmail(cfg, order, url.origin);
  const replyTo = isEmail(cfg.notify_email) ? cfg.notify_email : isEmail(cfg.contact) ? cfg.contact : undefined;
  const r = await sendEmail(env, { ...msg, from: fromLine({ ...cfg, email_from: senderFor(cfg, url) }), to: order.contact, replyTo });
  if (!r.ok) console.error('confirmation email failed:', r.error);
}

async function sendTestEmail(env, url) {
  const cfg = await getConfig(env);
  if (!emailReady(env)) throw new HttpError(409, 'Email isn’t set up yet: the RESEND_API_KEY secret is missing in Cloudflare.');
  if (!cfg.notify_email) throw new HttpError(400, 'Fill in “Send online-order notices to” and save first.');
  const from = senderFor(cfg, url);
  if (!from) throw new HttpError(400, 'Emails only work on the site’s own domain address (like ghems.corkandpin.com), not this one.');
  const r = await sendEmail(env, { ...testEmail({ ...cfg, email_from: from }, url.origin), from: fromLine({ ...cfg, email_from: from }), to: cfg.notify_email });
  if (!r.ok) throw new HttpError(502, `The email didn’t send: ${r.error}`);
  return json({ ok: true, to: cfg.notify_email, from });
}

// ---------------------------------------------------------------- branding

const escHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const PAGE_TITLES = { '/buy': 'Buy squares', '/helper': 'Sign-up table', '/admin': 'Admin' };

// Put the group's colors, name and logo into a page on its way out, so it
// looks right from the first paint and link previews show the right thing.
async function brandPage(res, env, url) {
  const cfg = await getConfig(env);
  const path = url.pathname.replace(/\.html$/, '').replace(/^\/index$/, '/');
  const title = cfg.title || 'Squares';
  const pageTitle = PAGE_TITLES[path] ? `${PAGE_TITLES[path]} · ${title}` : title;
  const hasLogo = Number(cfg.logo_ver) > 0;
  const logoUrl = `/api/logo?v=${cfg.logo_ver}`;
  const description = (cfg.about_text || [cfg.org_name, cfg.subtitle].filter(Boolean).join(' · ') || title).replace(/\s+/g, ' ').trim();
  const head = [
    `<style id="brand">${themeCss(cfg.color_main || DEFAULT_MAIN, cfg.color_accent || DEFAULT_ACCENT)}</style>`,
    `<meta property="og:title" content="${escHtml(pageTitle)}">`,
    `<meta property="og:description" content="${escHtml(description)}">`,
    hasLogo ? `<meta property="og:image" content="${escHtml(url.origin + logoUrl)}">` : '',
    `<link rel="icon" href="${hasLogo ? `/api/icon?v=${cfg.logo_ver}` : '/icon-192.png'}">`,
  ].join('');
  const badge = hasLogo
    ? `<img class="brand-logo" src="${logoUrl}" alt="">`
    : `<span class="brand-logo badge-initials" aria-hidden="true">${escHtml(initials(cfg.org_name || title))}</span>`;
  const main = validColor(cfg.color_main) ? cfg.color_main : DEFAULT_MAIN;
  const fresh = new Response(res.body, res);
  fresh.headers.delete('etag');
  fresh.headers.delete('last-modified');
  fresh.headers.set('cache-control', 'no-cache, private');
  return new HTMLRewriter()
    .on('title', { element(el) { el.setInnerContent(pageTitle); } })
    .on('head', { element(el) { el.append(head, { html: true }); } })
    .on('meta[name="theme-color"]', { element(el) { el.setAttribute('content', main); } })
    .on('link[rel="apple-touch-icon"]', { element(el) { if (hasLogo) el.setAttribute('href', `/api/icon?v=${cfg.logo_ver}`); } })
    .on('link[rel="manifest"]', { element(el) { el.setAttribute('href', `/api/manifest?v=${cfg.logo_ver}`); } })
    .on('header.top .inner', { element(el) { el.prepend(badge, { html: true }); } })
    .transform(fresh);
}

async function logoImage(env, name) {
  const row = await env.DB.prepare('SELECT mime, data FROM assets WHERE name = ?').bind(name).first();
  if (row) {
    return new Response(Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0)), {
      headers: { 'content-type': row.mime, 'cache-control': 'public, max-age=31536000, immutable' },
    });
  }
  // No logo yet: a badge with the group's initials, in their colors.
  const cfg = await getConfig(env);
  const text = escHtml(initials(cfg.org_name || cfg.title));
  const size = text.length > 3 ? 150 : text.length === 3 ? 190 : 230;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="${escHtml(cfg.color_main || DEFAULT_MAIN)}"/><text x="256" y="256" dy=".35em" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" font-weight="800" font-size="${size}" fill="${escHtml(cfg.color_accent || DEFAULT_ACCENT)}">${text}</text></svg>`;
  return new Response(svg, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'no-cache' } });
}

async function manifest(env) {
  const cfg = await getConfig(env);
  const v = cfg.logo_ver;
  const icons = Number(v) > 0
    ? [{ src: `/api/icon?v=${v}`, sizes: '512x512', type: 'image/png' }]
    : [{ src: '/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }];
  return new Response(
    JSON.stringify({
      name: `${cfg.title || 'Squares'} sign-up`,
      short_name: (cfg.org_name || 'Squares').slice(0, 12),
      start_url: '/helper',
      scope: '/',
      display: 'standalone',
      background_color: '#ffffff',
      theme_color: validColor(cfg.color_main) ? cfg.color_main : DEFAULT_MAIN,
      icons,
    }),
    { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'no-cache' } },
  );
}

// The admin page sends the cropped logo and a home-screen icon, both already
// shrunk to small PNGs in the browser.
function imageData(dataUrl, label) {
  const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
  if (!m) throw new HttpError(400, `The ${label} must be a PNG, JPEG or WebP image.`);
  if (m[2].length > 700_000) throw new HttpError(400, `The ${label} is too large. Try a smaller image.`);
  return { mime: m[1], data: m[2] };
}

async function saveLogo(env, body) {
  const logo = imageData(body.logo, 'logo');
  const icon = imageData(body.icon, 'icon');
  const put = (name, img) =>
    env.DB.prepare('INSERT OR REPLACE INTO assets (name, mime, data, updated_at) VALUES (?, ?, ?, ?)').bind(name, img.mime, img.data, now());
  await env.DB.batch([
    put('logo', logo),
    put('icon', icon),
    // A timestamp, so a re-uploaded logo never reuses a cached older image's address.
    env.DB.prepare("UPDATE config SET value = ? WHERE key = 'logo_ver'").bind(String(now())),
    bumpStmt(env),
  ]);
  return json({ ok: true });
}

async function deleteLogo(env) {
  // logo_ver 0 means "no logo".
  await env.DB.batch([
    env.DB.prepare("DELETE FROM assets WHERE name IN ('logo', 'icon')"),
    env.DB.prepare("UPDATE config SET value = '0' WHERE key = 'logo_ver'"),
    bumpStmt(env),
  ]);
  return json({ ok: true });
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
  let order = null;
  if (me) order = await orderInfo(env, cfg, me);
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
      names: b.squares.map((s) => (s.status === 'sold' || s.status === 'pending' ? shortName(s.buyer_name) : null)),
      pending: b.squares.filter((s) => s.status === 'pending').map((s) => s.idx),
    })),
    scores,
    mine,
    meName,
    order,
    online: cfg.online_open === '1' && cfg.sales_open === '1' ? { price_cents: Number(cfg.price_cents) } : null,
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
      pay: payConfig(cfg),
      sales_open: cfg.sales_open === '1',
    },
    boards: boards.map((b) => ({
      id: b.id,
      squares: b.squares.map((s) => {
        if (s.status === 'sold') return { s: 'sold', n: shortName(s.buyer_name) };
        if (s.status === 'pending') return { s: 'pending', n: shortName(s.buyer_name) };
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

async function hold(env, body, session, online = false) {
  const cart = cartId(body);
  const board = int(body.board, 'board');
  const idx = int(body.idx, 'square');
  if (idx < 0 || idx > 99) throw new HttpError(400, 'Invalid square.');
  const cfg = await getConfig(env);
  if (cfg.sales_open !== '1') throw new HttpError(409, 'Sales are closed.');
  if (online) {
    if (cfg.online_open !== '1') throw new HttpError(409, 'Online sales are closed.');
    const max = Number(cfg.online_max || 20);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM squares WHERE hold_cart = ? AND status = 'held' AND NOT (board_id = ? AND idx = ?)",
    )
      .bind(cart, board, idx)
      .first();
    if (row.n >= max) throw new HttpError(409, `Online orders can have up to ${max} squares.`);
  }
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

// Turn the squares a cart holds into an order, all or nothing.
//   Helper sale: status 'confirmed', squares become 'sold'.
//   Online order: status 'reserved', squares become 'pending' until confirmed.
async function placeOrder(env, cfg, o) {
  const { results: held } = await env.DB.prepare(
    "SELECT board_id, idx FROM squares WHERE hold_cart = ? AND status = 'held'",
  )
    .bind(o.cart)
    .all();
  const key = (b, i) => `${b}:${i}`;
  const heldSet = new Set(held.map((r) => key(r.board_id, r.idx)));
  const expectSet = new Set(o.expect.map(([b, i]) => key(b, i)));
  const lost = [...expectSet].filter((k) => !heldSet.has(k));
  if (lost.length || heldSet.size !== expectSet.size) {
    throw new HttpError(409, 'Some squares in this order were taken by someone else.', {
      lost: lost.map((k) => k.split(':').map(Number)),
    });
  }

  const token = randomToken();
  const unit = Number(cfg.price_cents);
  const squareStatus = o.status === 'confirmed' ? 'sold' : 'pending';
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sales (token, buyer_name, contact, method, unit_cents, square_count, helper, note,
                          created_at, status, source, code, expires_at, confirmed_at, ip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      token, o.buyerName, o.contact, o.method, unit, expectSet.size, o.helper ?? null, o.note || null,
      now(), o.status, o.source, o.code ?? null, o.expiresAt ?? null,
      o.status === 'confirmed' ? now() : null, o.ip ?? null,
    ),
    env.DB.prepare(
      `UPDATE squares SET status = ?, sale_id = (SELECT id FROM sales WHERE token = ?),
              hold_cart = NULL, hold_helper = NULL, hold_until = NULL
       WHERE hold_cart = ? AND status = 'held'`,
    ).bind(squareStatus, token, o.cart),
    bumpStmt(env),
  ]);

  // If someone grabbed an expired square in the split second between the
  // check and the update, undo the whole order rather than charge for fewer squares.
  if (results[1].meta.changes !== expectSet.size) {
    const until = now() + Number(cfg.hold_minutes || 3) * 60_000;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE squares SET status = 'held', hold_cart = ?, hold_helper = ?, hold_until = ?, sale_id = NULL
         WHERE sale_id = (SELECT id FROM sales WHERE token = ?)`,
      ).bind(o.cart, o.helper ?? ONLINE_BUYER, until, token),
      env.DB.prepare('DELETE FROM sales WHERE token = ?').bind(token),
      bumpStmt(env),
    ]);
    throw new HttpError(409, 'Some squares in this order were taken by someone else. Try again.');
  }

  await ensureOpenBoard(env);
  return { token, count: expectSet.size, amount_cents: unit * expectSet.size };
}

function orderFields(body) {
  const buyerName = String(body.buyer_name || '').trim().slice(0, 60);
  const contact = String(body.contact || '').trim().slice(0, 80);
  const expect = Array.isArray(body.expect) ? body.expect : [];
  if (!buyerName) throw new HttpError(400, 'Enter a first and last name.');
  if (!contact) throw new HttpError(400, 'Enter a phone number or email so we can reach a winner.');
  if (expect.length === 0) throw new HttpError(400, 'No squares selected.');
  return { cart: cartId(body), buyerName, contact, expect };
}

async function sell(env, body, session, url) {
  const f = orderFields(body);
  const method = String(body.method || '');
  if (!METHODS.includes(method)) throw new HttpError(400, 'Choose how they paid.');
  const cfg = await getConfig(env);
  if (cfg.sales_open !== '1') throw new HttpError(409, 'Sales are closed.');
  const r = await placeOrder(env, cfg, {
    ...f,
    method,
    note: String(body.note || '').trim().slice(0, 200),
    helper: session.name,
    status: 'confirmed',
    source: 'helper',
  });
  return json({ ok: true, ...r, link: `${url.origin}/?me=${r.token}` });
}

// ---------------------------------------------------------------- online orders

// Short code for the Venmo note, without look-alike characters (0/O, 1/I/L).
function orderCode() {
  const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return [...crypto.getRandomValues(new Uint8Array(4))].map((b) => abc[b % abc.length]).join('');
}

async function ipHash(request) {
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const d = await crypto.subtle.digest('SHA-256', enc.encode(`squares-ip|${ip}`));
  return b64u(d).slice(0, 16);
}

async function buyState(env, url) {
  const v = await getVersion(env);
  if (url.searchParams.get('v') === String(v)) return json({ v, same: true, t: now() });
  const cart = url.searchParams.get('cart') || '';
  const cfg = await getConfig(env);
  const boards = await boardsWithSquares(env, "WHERE status = 'open'");
  return json({
    v,
    t: now(),
    config: {
      title: cfg.title,
      top_name: cfg.top_name,
      side_name: cfg.side_name,
      price_cents: Number(cfg.price_cents),
      hold_minutes: Number(cfg.hold_minutes),
      online_max: Number(cfg.online_max),
      reserve_minutes: Number(cfg.reserve_minutes),
      open: cfg.online_open === '1' && cfg.sales_open === '1',
    },
    boards: boards.map((b) => ({
      id: b.id,
      squares: b.squares.map((s) => {
        if (s.status === 'sold' || s.status === 'pending') return { s: 'sold', n: shortName(s.buyer_name) };
        if (s.status === 'held' && s.hold_until > now()) {
          return s.hold_cart === cart ? { s: 'mine', u: s.hold_until } : { s: 'held', u: s.hold_until };
        }
        return { s: 'open' };
      }),
    })),
  });
}

async function reserveOnline(env, body, request, url) {
  const f = orderFields(body);
  const cfg = await getConfig(env);
  if (cfg.sales_open !== '1' || cfg.online_open !== '1') throw new HttpError(409, 'Online sales are closed.');
  if (f.expect.length > Number(cfg.online_max || 20)) {
    throw new HttpError(409, `Online orders can have up to ${cfg.online_max} squares.`);
  }
  // Keep one person from tying up lots of squares without paying.
  const ip = await ipHash(request);
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM sales WHERE ip = ? AND status IN ('reserved', 'pending')",
  )
    .bind(ip)
    .first();
  if (open.n >= 5) {
    throw new HttpError(429, 'You have several orders waiting already. Pay for those, or wait for them to be confirmed, first.');
  }
  let code = orderCode();
  for (let i = 0; i < 5; i++) {
    const clash = await env.DB.prepare(
      "SELECT 1 FROM sales WHERE code = ? AND status IN ('reserved', 'pending', 'confirmed')",
    )
      .bind(code)
      .first();
    if (!clash) break;
    code = orderCode();
  }
  const r = await placeOrder(env, cfg, {
    ...f,
    method: 'online', // which app becomes known when they tap "I paid with ..."
    status: 'reserved',
    source: 'online',
    code,
    expiresAt: now() + Number(cfg.reserve_minutes || 30) * 60_000,
    ip,
  });
  return json({ ok: true, ...r, code, link: `${url.origin}/?me=${r.token}` });
}

// Public view of one order, for the buyer's link.
async function orderInfo(env, cfg, token) {
  const o = await env.DB.prepare(
    `SELECT id, status, source, code, method, unit_cents, square_count, expires_at, created_at
     FROM sales WHERE token = ?`,
  )
    .bind(token)
    .first();
  if (!o || o.source !== 'online') return null;
  const { results } = await env.DB.prepare(
    'SELECT board_id, idx FROM squares WHERE sale_id = ? ORDER BY board_id, idx',
  )
    .bind(o.id)
    .all();
  return {
    status: o.status,
    code: o.code,
    amount_cents: o.unit_cents * o.square_count,
    count: o.square_count,
    expires_at: o.expires_at,
    squares: results.map((r) => [r.board_id, r.idx]),
    method: o.method,
    pay: payConfig(cfg),
    t: now(),
  };
}

async function markPaid(env, body, url, ctx) {
  const token = String(body?.token || '');
  const via = PAY_APPS.includes(body?.method) ? body.method : 'online';
  const cfg = await getConfig(env);
  const res = await env.DB.prepare(
    `UPDATE sales SET status = 'pending', paid_at = ?, expires_at = ?, method = ?
     WHERE token = ? AND source = 'online' AND status = 'reserved'`,
  )
    .bind(now(), now() + Number(cfg.confirm_hours || 24) * 3600_000, via, token)
    .run();
  if (res.meta.changes !== 1) {
    const o = await env.DB.prepare('SELECT status FROM sales WHERE token = ?').bind(token).first();
    if (o?.status === 'pending' || o?.status === 'confirmed') return json({ ok: true });
    throw new HttpError(409, 'This order is no longer reserved. Its squares may have gone back on sale.');
  }
  await bump(env);
  // Let the organizers know to check the app (sent after the reply, so the buyer isn't kept waiting).
  ctx?.waitUntil(notifyPaid(env, cfg, token, url.origin));
  return json({ ok: true });
}

// Release an order's squares and close it out with the given status.
async function closeOrder(env, where, binds, status) {
  const { results } = await env.DB.prepare(`SELECT id FROM sales WHERE ${where}`)
    .bind(...binds)
    .all();
  if (!results.length) return 0;
  const ids = results.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE squares SET status = 'open', sale_id = NULL WHERE sale_id IN (${marks}) AND status = 'pending'`,
    ).bind(...ids),
    env.DB.prepare(`UPDATE sales SET status = ? WHERE id IN (${marks})`).bind(status, ...ids),
    bumpStmt(env),
  ]);
  return ids.length;
}

async function cancelOnline(env, body) {
  const n = await closeOrder(
    env,
    "token = ? AND source = 'online' AND status = 'reserved'",
    [String(body?.token || '')],
    'cancelled',
  );
  if (!n) throw new HttpError(409, 'Only an order that hasn’t been paid yet can be cancelled here.');
  return json({ ok: true });
}

// Reserved/pending orders whose time ran out go back on sale. Runs at most
// every 15 seconds per worker instance, on any request.
let lastSweep = 0;
async function sweepExpired(env) {
  if (now() - lastSweep < 15_000) return;
  lastSweep = now();
  await closeOrder(env, "status IN ('reserved', 'pending') AND expires_at < ?", [now()], 'expired');
}

async function confirmOrder(env, body, url, ctx) {
  const id = int(body.sale, 'order');
  const res = await env.DB.prepare(
    `UPDATE sales SET status = 'confirmed', confirmed_at = ?, expires_at = NULL
     WHERE id = ? AND status IN ('reserved', 'pending')`,
  )
    .bind(now(), id)
    .run();
  if (res.meta.changes !== 1) {
    throw new HttpError(409, 'That order can’t be confirmed. It may have expired and its squares gone back on sale.');
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE squares SET status = 'sold' WHERE sale_id = ? AND status = 'pending'").bind(id),
    bumpStmt(env),
  ]);
  await ensureOpenBoard(env);
  // Tell the buyer, if they gave an email.
  const cfg = await getConfig(env);
  const order = await orderForEmail(env, 'id', id);
  let emailed = null;
  if (order && isEmail(order.contact) && emailReady(env) && senderFor(cfg, url)) {
    emailed = order.contact;
    ctx?.waitUntil(emailBuyer(env, cfg, order, url));
  }
  return json({ ok: true, emailed });
}

async function rejectOrder(env, body) {
  const id = int(body.sale, 'order');
  const n = await closeOrder(env, "id = ? AND status IN ('reserved', 'pending')", [id], 'rejected');
  if (!n) throw new HttpError(409, 'That order isn’t waiting anymore.');
  return json({ ok: true });
}

// ---------------------------------------------------------------- scores

function inGameWindow(gameDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(gameDate || '')) return false;
  const start = Date.parse(`${gameDate}T12:00:00Z`);
  return now() >= start && now() <= start + 24 * 3600_000; // noon UTC to noon UTC next day
}

// ESPN_BASE is only for local testing (pointing at a relay); production leaves it unset.
async function fetchScoreboard(gameDate, env) {
  const ymd = gameDate.replace(/-/g, '');
  const base = env.ESPN_BASE || 'https://site.api.espn.com';
  const res = await fetch(`${base}/apis/site/v2/sports/football/nfl/scoreboard?dates=${ymd}`, {
    headers: { accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`ESPN returned ${res.status}`);
  return res.json();
}

// No teams entered yet: if ESPN has exactly one game that day (always true on
// Super Bowl Sunday), use it. Team names are filled in too unless the admin
// already typed their own; then the abbreviations are matched to those names.
async function adoptOnlyGame(env, cfg, data) {
  const games = listGames(data);
  if (games.length !== 1) {
    throw new Error(
      games.length
        ? `ESPN lists ${games.length} games on ${cfg.game_date}. Pick yours with “Find the game on ESPN” on the admin page.`
        : `ESPN doesn't list a game with both teams on ${cfg.game_date} yet.`,
    );
  }
  const { away, home } = games[0];
  const defaults = cfg.top_name === 'AFC' && cfg.side_name === 'NFC';
  const like = (typed, team) => typed && team.name && typed.toLowerCase().includes(team.name.toLowerCase());
  let top = away;
  let side = home;
  if (!defaults && (like(cfg.top_name, home) || like(cfg.side_name, away))) [top, side] = [home, away];
  const updates = { top_abbr: top.abbr, side_abbr: side.abbr };
  if (defaults) Object.assign(updates, { top_name: top.name, side_name: side.name });
  await env.DB.batch([
    ...Object.entries(updates).map(([k, v]) =>
      env.DB.prepare('UPDATE config SET value = ? WHERE key = ?').bind(v, k),
    ),
    bumpStmt(env),
  ]);
  Object.assign(cfg, updates);
}

async function getScores(env, force) {
  const cfg = await getConfig(env);
  let cache = null;
  try {
    cache = cfg.live_cache ? JSON.parse(cfg.live_cache) : null;
  } catch {
    cache = null;
  }
  const stale = !cache || now() - cache.fetched_at > SCORE_CACHE_MS;
  // Once the game is over, stop asking ESPN.
  const finished = cache?.live?.state === 'post';
  if (cfg.game_date && stale && (force || (inGameWindow(cfg.game_date) && !finished))) {
    try {
      const data = await fetchScoreboard(cfg.game_date, env);
      if (!(cfg.top_abbr && cfg.side_abbr)) await adoptOnlyGame(env, cfg, data);
      cache = { ...parseEspn(data, cfg), fetched_at: now(), error: null };
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

async function adminState(env, adminUrl) {
  // Scores first: on game day this may fill in the teams, which cfg should show.
  const scores = await getScores(env, false);
  const cfg = await getConfig(env);
  const boards = await boardsWithSquares(env, '');
  const { results: sales } = await env.DB.prepare('SELECT * FROM sales ORDER BY id DESC').all();
  const { results: refunds } = await env.DB.prepare('SELECT * FROM refunds').all();
  const { results: prizes } = await env.DB.prepare('SELECT * FROM prizes').all();
  const { results: overrides } = await env.DB.prepare('SELECT * FROM score_overrides').all();

  const salesById = new Map(sales.map((s) => [s.id, { ...s, squares: [] }]));
  const salesByToken = new Map([...salesById.values()].map((s) => [s.token, s]));
  for (const b of boards) {
    for (const sq of b.squares) {
      if (sq.status === 'sold' || sq.status === 'pending') salesByToken.get(sq.token)?.squares.push([b.id, sq.idx]);
    }
  }
  const confirmed = [...salesById.values()].filter((s) => s.status === 'confirmed');
  // Online orders: waiting ones first, then the last few that closed without a sale.
  const waiting = [...salesById.values()].filter((s) => s.status === 'reserved' || s.status === 'pending');
  const closed = [...salesById.values()]
    .filter((s) => s.source === 'online' && ['rejected', 'expired', 'cancelled'].includes(s.status))
    .slice(0, 15);

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
  totals.waiting_cents = waiting.reduce((a, s) => a + s.unit_cents * s.square_count, 0);
  for (const s of confirmed) {
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
      pending: b.squares.filter((s) => s.status === 'pending').length,
    })),
    sales: confirmed,
    orders: { waiting: waiting.reverse(), closed },
    email: { ready: emailReady(env), from: senderFor(cfg, adminUrl) },
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
    if (NUMERIC_CONFIG.includes(k)) {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${k}.`);
    }
    if (k === 'sales_open' || k === 'online_open') value = value === '1' || value === 'true' ? '1' : '0';
    if (k === 'game_date' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new HttpError(400, 'Game date must look like 2027-02-14.');
    }
    if (k === 'top_abbr' || k === 'side_abbr') value = value.toUpperCase();
    if (k === 'cashapp_tag' || k === 'venmo_user' || k === 'paypal_id') value = payHandle(k, value);
    if (k === 'notify_email' && value && !isEmail(value)) throw new HttpError(400, 'That doesn’t look like an email address.');
    if ((k === 'color_main' || k === 'color_accent') && !validColor(value)) throw new HttpError(400, 'Colors look like #1d4f91.');
    if (k === 'setup_done') value = value === '1' || value === 'true' ? '1' : '0';
    if (k === 'logo_ver') continue; // changes only with the logo itself
    const max = k === 'about_text' ? 600 : 120;
    if (value.length > max) throw new HttpError(400, `That's too long (${max} characters at most).`);
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
    const pend = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM squares WHERE board_id = ? AND status = 'pending'",
    )
      .bind(id)
      .first();
    throw new HttpError(
      409,
      pend.n
        ? `Board ${id} has ${pend.n} online square${pend.n === 1 ? '' : 's'} waiting for payment to be confirmed. Confirm or reject ${pend.n === 1 ? 'it' : 'them'} first.`
        : `Board ${id} has only ${sold.n} of 100 squares sold. Only full boards get numbers.`,
    );
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
// Wipe the game for next year: all boards, sales, refunds, prizes and scores.
// Teams and game date are cleared (next year's aren't known yet); the title,
// price, hold time, Venmo username and prize line stay. Requires the admin to
// type START OVER.
async function startNewYear(env, body) {
  if (String(body.confirm || '').trim().toUpperCase() !== 'START OVER') {
    throw new HttpError(400, 'To start a new year, type START OVER exactly.');
  }
  const set = (k, v) => env.DB.prepare('UPDATE config SET value = ? WHERE key = ?').bind(v, k);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM squares'),
    env.DB.prepare('DELETE FROM sales'),
    env.DB.prepare('DELETE FROM refunds'),
    env.DB.prepare('DELETE FROM prizes'),
    env.DB.prepare('DELETE FROM score_overrides'),
    env.DB.prepare('DELETE FROM boards'),
    set('top_name', 'AFC'),
    set('top_abbr', ''),
    set('side_name', 'NFC'),
    set('side_abbr', ''),
    set('game_date', ''),
    set('live_cache', ''),
    set('sales_open', '1'),
  ]);
  await newBoard(env); // Board 1, and bumps the version so every screen refreshes
  return json({ ok: true });
}

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

async function espnGames(env, url) {
  const cfg = await getConfig(env);
  const date = url.searchParams.get('date') || cfg.game_date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'Set the game date first.');
  try {
    return json({ date, games: listGames(await fetchScoreboard(date, env)) });
  } catch (err) {
    throw new HttpError(502, `Couldn't reach ESPN: ${err.message || err}`);
  }
}

async function refreshScores(env) {
  const cfg = await getConfig(env);
  if (!cfg.game_date) throw new HttpError(400, 'Set the game date first.');
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
