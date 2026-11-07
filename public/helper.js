import { $, esc, api, money, toast, signIn, session, saveSession, boardHtml, sqLabel, fitBoard, onResize } from './common.js?v=26';
import { payOptions, payLink, handleText, fillsNote, qrHtml } from './pay.js?v=26';

const CART_KEY = 'squares-cart';

let sess = null;
let data = null;
let offset = 0; // server clock minus tablet clock
let current = null;
let modalOpen = false;
const busy = new Set();

function newCart() {
  const id = crypto.randomUUID();
  try { sessionStorage.setItem(CART_KEY, id); } catch { /* ignore */ }
  return id;
}
let cart = (() => {
  try { return sessionStorage.getItem(CART_KEY) || newCart(); } catch { return newCart(); }
})();

const serverNow = () => Date.now() + offset;

// ------------------------------------------------------------ data

async function load(full = false) {
  const q = new URLSearchParams({ cart });
  if (data && !full) q.set('v', data.v);
  let res;
  try {
    res = await api(`/state?${q}`);
  } catch (e) {
    if (e.status === 401) return signOut();
    throw e;
  }
  offset = res.t - Date.now();
  if (!res.same) {
    data = res;
    render();
  } else {
    renderCart();
  }
}

// Squares this cart holds, whether or not the timer ran out
// (an expired hold nobody else took can still be renewed).
function myHolds() {
  const out = [];
  for (const b of data?.boards || []) {
    b.squares.forEach((s, idx) => {
      if (s.s === 'mine') out.push({ board: b.id, idx, until: s.u });
    });
  }
  return out;
}

// ------------------------------------------------------------ render

function render() {
  if (!data) return;
  const app = $('#app');
  const cfg = data.config;
  $('#sub').textContent = `${cfg.title} · ${money(cfg.price_cents)} a square`;

  const boards = data.boards;
  if (!boards.some((b) => b.id === current)) {
    const withRoom = boards.find((b) => b.squares.some((s) => s.s === 'open'));
    current = (withRoom || boards[0])?.id ?? null;
  }

  let html = '';
  if (!cfg.sales_open) {
    html += `<div class="msg error" style="margin-bottom:12px">Sales are closed. Squares can't be picked right now.</div>`;
  }
  if (!boards.length) {
    html += `<div class="card"><p>No boards are open for sale.</p></div>`;
    app.innerHTML = html;
    renderCart();
    return;
  }

  html += `<div class="helper-bar"><div class="tabs" role="tablist">${boards
    .map((b) => {
      const free = b.squares.filter((s) => s.s === 'open' || (s.s === 'held' && s.u < serverNow())).length;
      return `<button role="tab" data-board="${b.id}" aria-selected="${b.id === current}">Board ${b.id}<span class="count">${free} left</span></button>`;
    })
    .join('')}</div>
    <span class="hint">Tap a square to pick it, tap again to drop it. Grey = another helper has it.</span></div>`;

  const board = boards.find((b) => b.id === current);
  html += `<div class="card tight"><div class="board-wrap">${boardHtml({
    topName: cfg.top_name,
    sideName: cfg.side_name,
    cols: null,
    rows: null,
    cell: (idx) => cellFor(board, idx),
  })}</div></div>`;
  app.innerHTML = html;
  fitHelperBoard();
  nextExpiry = soonestOtherHold();
  renderCart();
}

// When another helper's hold runs out, redraw so the square shows as open
// again, even if their tablet was closed and nothing else changes.
let nextExpiry = null;
function soonestOtherHold() {
  let soonest = null;
  const t = serverNow();
  for (const b of data?.boards || []) {
    for (const s of b.squares) {
      if (s.s === 'held' && s.u > t && (soonest === null || s.u < soonest)) soonest = s.u;
    }
  }
  return soonest;
}

const fitHelperBoard = () => fitBoard($('#app .board'), { bottom: 12, minShare: 0.35, maxRatio: 1.8 });
onResize(fitHelperBoard);

function cellFor(board, idx) {
  const s = board.squares[idx];
  const label = sqLabel(board.id, idx);
  const num = `<span class="num">${idx}</span>`;
  const isBusy = busy.has(`${board.id}:${idx}`) ? ' busy' : '';
  const expired = (s.s === 'held' || s.s === 'mine') && s.u < serverNow();
  if (s.s === 'sold') return { cls: 'sold', html: `${num}${esc(s.n)}`, title: `${label}: ${s.n}` };
  if (s.s === 'pending') {
    return { cls: 'pending', html: `${num}${esc(s.n)}`, title: `${label}: online order by ${s.n}, waiting for payment to be confirmed` };
  }
  if (s.s === 'mine') {
    return { cls: `mine${isBusy}`, html: `${num}<span class="pick">Picked</span>`, button: true, title: `${label}: in this order` };
  }
  if (s.s === 'held' && !expired) {
    return { cls: `held${isBusy}`, html: `${num}${esc(s.n)}`, button: true, title: `${label}: held by ${s.n}` };
  }
  return { cls: `open${isBusy}`, html: num, button: true, title: `${label}: open` };
}

// If showing or hiding the order changes the header's height (it can wrap
// onto two lines on narrow screens), re-fit the grid to the new space.
let headerH = 0;
function refitIfHeaderChanged() {
  const h = document.querySelector('header.top').offsetHeight;
  if (h !== headerH) {
    headerH = h;
    if (!modalOpen) fitHelperBoard();
  }
}

function renderCart() {
  const bar = $('#cartbar');
  const holds = data ? myHolds() : [];
  if (!holds.length || modalOpen) {
    bar.classList.add('hidden');
    document.body.classList.remove('has-cart');
    refitIfHeaderChanged();
    if (modalOpen) updateModalTimer();
    return;
  }
  bar.classList.remove('hidden');
  document.body.classList.add('has-cart');
  refitIfHeaderChanged();
  const n = holds.length;
  $('#cartSum').textContent = `${n} square${n === 1 ? '' : 's'} · ${money(n * data.config.price_cents)}`;
  const left = Math.min(...holds.map((h) => h.until)) - serverNow();
  const t = $('#cartTimer');
  t.textContent = left > 0 ? `${fmtLeft(left)} left` : 'time’s up';
  t.classList.toggle('low', left < 45_000);
  // Time ran out and they're not on the payment screen: let the squares go so
  // other helpers can sell them. (On the payment screen the helper can still
  // tap "More time", so a sale in progress isn't lost.)
  if (left <= 0) releaseExpired();
}

let releasing = false;
async function releaseExpired() {
  if (releasing) return;
  releasing = true;
  try {
    await api('/release', { method: 'POST', body: { cart } });
    toast('Time ran out, so those squares were let go.');
    await load(true);
  } catch {
    /* try again on the next tick */
  } finally {
    releasing = false;
  }
}

// Runs every second: countdown, auto-release, and redraw on others' expiry.
function tick() {
  renderCart();
  if (nextExpiry !== null && serverNow() >= nextExpiry && !modalOpen) render();
}

function fmtLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------ actions

$('#app').addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-board]');
  if (tab) {
    current = Number(tab.dataset.board);
    render();
    return;
  }
  const btn = e.target.closest('button.sq');
  if (!btn || !data) return;
  const idx = Number(btn.dataset.idx);
  const board = data.boards.find((b) => b.id === current);
  const s = board.squares[idx];
  const key = `${board.id}:${idx}`;
  if (busy.has(key)) return;
  if (s.s === 'held' && s.u >= serverNow()) {
    toast(`${s.n} is holding that one right now.`);
    return;
  }
  busy.add(key);
  btn.classList.add('busy');
  try {
    if (s.s === 'mine') {
      await api('/release', { method: 'POST', body: { cart, board: board.id, idx } });
    } else {
      await api('/hold', { method: 'POST', body: { cart, board: board.id, idx } });
    }
  } catch (ex) {
    toast(ex.message);
  } finally {
    busy.delete(key);
    await load(true).catch(() => {});
  }
});

$('#cartClear').addEventListener('click', async () => {
  if (!confirm('Let go of all the squares in this order?')) return;
  await api('/release', { method: 'POST', body: { cart } }).catch((e) => toast(e.message));
  await load(true);
});

$('#cartCheckout').addEventListener('click', openCheckout);

// ------------------------------------------------------------ checkout

function showModal(html) {
  modalOpen = true;
  $('#modalBody').innerHTML = html;
  $('#modal').classList.remove('hidden');
  renderCart();
}
function closeModal() {
  modalOpen = false;
  $('#modal').classList.add('hidden');
  $('#modalBody').innerHTML = '';
  renderCart();
}

function openCheckout() {
  const holds = myHolds();
  if (!holds.length) return;
  const cfg = data.config;
  const n = holds.length;
  const amount = money(n * cfg.price_cents);
  const labels = holds.map((h) => sqLabel(h.board, h.idx));
  const memo = `Squares ${labels.join(' ')}`;
  const cents = n * cfg.price_cents;
  // Payment tabs: each app the group set up, then cash and "other".
  const apps = payOptions(cfg.pay);
  const tabs = [...apps.map((o) => ({ ...o, app: true })), { id: 'cash', label: 'Cash' }, { id: 'other', label: 'Other' }];
  let method = tabs[0].id;
  const panel = (id) => {
    const o = tabs.find((t) => t.id === id);
    if (!o.app) {
      return `<div class="stack"><div class="amount">${amount}</div>
        <div class="small">${id === 'cash' ? `Collect ${amount} in cash.` : 'Note how they paid in the note below.'}</div></div>`;
    }
    const link = payLink(o, cents, memo);
    return `<div class="pay">
        ${link ? qrHtml(link, o.label) : ''}
        <div class="stack">
          <div class="amount">${amount}</div>
          <div>${esc(o.label)} <strong>${esc(handleText(o))}</strong></div>
          <div class="small">${link
            ? `They scan the code with their phone camera. ${esc(o.label)} opens with ${amount}${fillsNote(o) ? ' and this note' : ''} filled in.`
            : `They send ${amount} to this account in the ${esc(o.label)} app.`}
            ${fillsNote(o) ? `<br><span class="memo">${esc(memo)}</span>`
              // Cash App insists on a note but can't have it filled in: keep it short.
              // (Match the payment by name and amount; the helper is watching it arrive.)
              : o.id === 'cashapp' ? `<br>Cash App needs a note. Have them type: <span class="memo">Squares</span>`
              : ''}</div>
        </div>
      </div>`;
  };
  showModal(`
    <h2>Take payment</h2>
    <p class="muted" style="margin-top:0">${n} square${n === 1 ? '' : 's'}: ${esc(labels.join(', '))}</p>
    <div class="small muted" style="font-weight:600;margin-bottom:4px">Paying with</div>
    <div class="seg" id="methods">${tabs.map((t) => `<button type="button" class="btn" data-method="${t.id}" aria-pressed="${t.id === method}">${esc(t.label)}</button>`).join('')}</div>
    ${apps.length ? '' : '<p class="small muted">Add Cash App, Venmo or PayPal on the admin page (Settings) to show a pay code here.</p>'}
    <div id="payPanel" style="margin-top:12px">${panel(method)}</div>
    <div class="row" style="margin-top:8px"><span class="small muted" id="modalTimer"></span>
      <button class="btn sm" type="button" id="more">+ More time</button></div>
    <hr style="border:none;border-top:1px solid var(--line);margin:16px 0">
    <form id="sellForm" class="stack" autocomplete="off">
      <div class="form-grid">
        <label class="field"><span>Buyer's name</span><input type="text" name="buyer_name" required maxlength="60" placeholder="First and last name"></label>
        <label class="field"><span>Phone or email (to text their link and reach winners)</span><input type="text" name="contact" required maxlength="80" inputmode="email"></label>
      </div>
      <label class="field"><span>Note (optional)</span><input type="text" name="note" maxlength="200" placeholder="e.g. paid from a spouse's account"></label>
      <div class="msg error hidden" id="sellErr" role="alert"></div>
      <div class="row">
        <button class="btn" type="button" id="back">← Back to board</button>
        <span style="flex:1"></span>
        <button class="btn primary big" type="submit" id="saveBtn"></button>
      </div>
      <p class="small muted" style="margin:0">Only tap Save after the payment shows up. Unsaved squares go back on sale when the timer runs out.</p>
    </form>`);
  updateModalTimer();
  const label = () => {
    const t = tabs.find((x) => x.id === method);
    $('#saveBtn').textContent = method === 'other' ? `They paid ${amount} · Save` : `Got ${amount} by ${t.label} · Save`;
  };
  label();
  $('#methods').addEventListener('click', (e) => {
    const b = e.target.closest('[data-method]');
    if (!b) return;
    method = b.dataset.method;
    $('#methods').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', x === b));
    $('#payPanel').innerHTML = panel(method);
    label();
  });
  $('#back').addEventListener('click', closeModal);
  $('#more').addEventListener('click', async () => {
    try {
      await api('/extend', { method: 'POST', body: { cart } });
      await load(true);
      toast('Timer restarted.');
    } catch (e) {
      toast(e.message);
    }
  });
  $('#sellForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#sellErr');
    err.classList.add('hidden');
    const submit = f.querySelector('[type=submit]');
    submit.disabled = true;
    try {
      const res = await api('/sell', {
        method: 'POST',
        body: {
          cart,
          expect: holds.map((h) => [h.board, h.idx]),
          buyer_name: f.buyer_name.value,
          contact: f.contact.value,
          method,
          note: f.note.value,
        },
      });
      showDone(res, f.buyer_name.value, f.contact.value, labels);
      cart = newCart();
      await load(true);
    } catch (ex) {
      submit.disabled = false;
      let msg = ex.message;
      if (ex.data?.lost?.length) {
        msg += ` Lost: ${ex.data.lost.map(([b, i]) => sqLabel(b, i)).join(', ')}. Go back, pick replacements, and adjust the payment if needed.`;
      }
      err.textContent = msg;
      err.classList.remove('hidden');
      await load(true).catch(() => {});
    }
  });
}

function updateModalTimer() {
  const el = $('#modalTimer');
  if (!el) return;
  const holds = myHolds();
  if (!holds.length) {
    el.textContent = '';
    return;
  }
  const left = Math.min(...holds.map((h) => h.until)) - serverNow();
  el.textContent = left > 0 ? `Squares held for ${fmtLeft(left)}` : 'Hold ran out. Tap “More time” before saving.';
  el.style.color = left < 45_000 ? 'var(--danger)' : '';
}

function showDone(res, name, contact, labels) {
  const first = name.trim().split(/\s+/)[0];
  const text = `Thanks ${first}! Your squares (${labels.join(', ')}): ${res.link}`;
  const digits = contact.replace(/[^\d+]/g, '');
  const isEmail = contact.includes('@');
  const sendHref = isEmail
    ? `mailto:${encodeURIComponent(contact.trim())}?subject=${encodeURIComponent('Your squares')}&body=${encodeURIComponent(text)}`
    : digits.length >= 10
      ? `sms:${digits}?&body=${encodeURIComponent(text)}`
      : null;
  showModal(`
    <h2>Saved ✓</h2>
    <p>${res.count} square${res.count === 1 ? '' : 's'} for <strong>${esc(name)}</strong> · ${money(res.amount_cents)}</p>
    <p class="small muted">Send them their link so they can watch their squares and the numbers:</p>
    <div class="linkbox" id="link">${esc(res.link)}</div>
    <div class="row" style="margin-top:12px">
      ${sendHref ? `<a class="btn primary" href="${esc(sendHref)}">${isEmail ? 'Email' : 'Text'} the link</a>` : ''}
      <button class="btn" type="button" id="copy">Copy link</button>
      <span style="flex:1"></span>
      <button class="btn primary big" type="button" id="next">Next buyer</button>
    </div>`);
  $('#copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(res.link);
      toast('Link copied.');
    } catch {
      toast('Couldn’t copy. Select the link and copy it.');
    }
  });
  $('#next').addEventListener('click', closeModal);
}

// ------------------------------------------------------------ boot

function signOut() {
  saveSession(null);
  location.reload();
}
$('#signout').addEventListener('click', async () => {
  await api('/release', { method: 'POST', body: { cart } }).catch(() => {});
  saveSession(null);
  location.href = '/';
});

async function start() {
  sess = session();
  if (!sess?.token) sess = await signIn($('#app'), { title: 'Helper sign-in' });
  $('#who').textContent = sess.name;
  if (sess.role === 'admin') $('#adminLink').classList.remove('hidden');
  $('#signout').classList.remove('hidden');
  await load(true);
  setInterval(() => load(false).catch(() => {}), 2000);
  setInterval(tick, 1000);
}
start();
