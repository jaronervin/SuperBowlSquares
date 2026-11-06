// Online buying: pick squares, enter your name, reserve, then pay with Venmo
// on your order page (/?me=...). The PTA confirms the payment.
import { $, esc, api, money, toast, boardHtml, sqLabel, fitBoard, onResize } from './common.js?v=17';

const CART_KEY = 'squares-buy-cart';
let data = null;
let offset = 0;
let current = null;
let modalOpen = false;
const busy = new Set();

function newCart() {
  const id = `web-${crypto.randomUUID()}`;
  try { sessionStorage.setItem(CART_KEY, id); } catch { /* ignore */ }
  return id;
}
let cart = (() => {
  try { return sessionStorage.getItem(CART_KEY) || newCart(); } catch { return newCart(); }
})();
const serverNow = () => Date.now() + offset;

async function load(full = false) {
  const q = new URLSearchParams({ cart });
  if (data && !full) q.set('v', data.v);
  const res = await api(`/buy/state?${q}`, { auth: false });
  offset = res.t - Date.now();
  if (!res.same) {
    data = res;
    render();
  } else {
    renderCart();
  }
}

function myHolds() {
  const out = [];
  for (const b of data?.boards || []) {
    b.squares.forEach((s, idx) => { if (s.s === 'mine') out.push({ board: b.id, idx, until: s.u }); });
  }
  return out;
}

function render() {
  const cfg = data.config;
  document.title = `Buy squares · ${cfg.title}`;
  $('#sub').textContent = `${cfg.title} · ${money(cfg.price_cents)} a square`;
  const app = $('#app');
  if (!cfg.open) {
    app.innerHTML = `<div class="card"><h2>Online sales are closed</h2>
      <p>Squares can't be bought online right now.</p><p><a href="/">See the boards</a></p></div>`;
    renderCart();
    return;
  }
  const boards = data.boards;
  if (!boards.some((b) => b.id === current)) {
    const withRoom = boards.find((b) => b.squares.some((s) => s.s === 'open'));
    current = (withRoom || boards[0])?.id ?? null;
  }
  if (!boards.length) {
    app.innerHTML = `<div class="card"><p>No boards are open right now.</p></div>`;
    renderCart();
    return;
  }
  let html = `<div class="helper-bar"><div class="tabs" role="tablist">${boards
    .map((b) => {
      const free = b.squares.filter((s) => s.s === 'open' || (s.s === 'held' && s.u < serverNow())).length;
      return `<button role="tab" data-board="${b.id}" aria-selected="${b.id === current}">Board ${b.id}<span class="count">${free} left</span></button>`;
    })
    .join('')}</div>
    <span class="hint">Tap squares to pick them (up to ${cfg.online_max}). Grey ones are taken.</span></div>`;
  const board = boards.find((b) => b.id === current);
  html += `<div class="card tight"><div class="board-wrap">${boardHtml({
    topName: cfg.top_name,
    sideName: cfg.side_name,
    cols: null,
    rows: null,
    cell: (idx) => cellFor(board, idx),
  })}</div></div>`;
  app.innerHTML = html;
  fitBuyBoard();
  nextExpiry = Math.min(Infinity, ...boards.flatMap((b) => b.squares.filter((q) => q.s === 'held' && q.u > serverNow()).map((q) => q.u)));
  renderCart();
}

// Redraw when someone else's hold runs out, so the square shows as open.
let nextExpiry = Infinity;

const fitBuyBoard = () => fitBoard($('#app .board'), { bottom: 12, minShare: 0.35, maxRatio: 1.8 });
onResize(fitBuyBoard);

function cellFor(board, idx) {
  const s = board.squares[idx];
  const label = sqLabel(board.id, idx);
  const num = `<span class="num">${idx}</span>`;
  const isBusy = busy.has(`${board.id}:${idx}`) ? ' busy' : '';
  if (s.s === 'sold') return { cls: 'sold', html: `${num}${esc(s.n)}`, title: `${label}: taken` };
  if (s.s === 'mine') return { cls: `mine${isBusy}`, html: `${num}<span class="pick">Picked</span>`, button: true, title: `${label}: picked` };
  if (s.s === 'held' && s.u >= serverNow()) return { cls: 'held', html: num, title: `${label}: someone is picking this one` };
  return { cls: `open${isBusy}`, html: num, button: true, title: `${label}: open` };
}

function renderCart() {
  const bar = $('#cartbar');
  const holds = data ? myHolds() : [];
  const show = holds.length && !modalOpen;
  bar.classList.toggle('hidden', !show);
  document.body.classList.toggle('has-cart', !!show);
  if (!show) return;
  const n = holds.length;
  $('#cartSum').textContent = `${n} square${n === 1 ? '' : 's'} · ${money(n * data.config.price_cents)}`;
  const left = Math.min(...holds.map((h) => h.until)) - serverNow();
  const t = $('#cartTimer');
  t.textContent = left > 0 ? `${fmtLeft(left)} left` : 'time’s up';
  t.classList.toggle('low', left < 45_000);
  if (left <= 0) releaseExpired();
}

const fmtLeft = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let releasing = false;
async function releaseExpired() {
  if (releasing) return;
  releasing = true;
  try {
    await api('/buy/release', { method: 'POST', body: { cart }, auth: false });
    toast('Time ran out, so your picks were let go. Tap squares to pick again.');
    await load(true);
  } catch { /* retry next tick */ } finally {
    releasing = false;
  }
}

$('#app').addEventListener('click', async (e) => {
  const tab = e.target.closest('[data-board]');
  if (tab) { current = Number(tab.dataset.board); render(); return; }
  const btn = e.target.closest('button.sq');
  if (!btn || !data) return;
  const idx = Number(btn.dataset.idx);
  const board = data.boards.find((b) => b.id === current);
  const s = board.squares[idx];
  const key = `${board.id}:${idx}`;
  if (busy.has(key)) return;
  busy.add(key);
  btn.classList.add('busy');
  try {
    if (s.s === 'mine') await api('/buy/release', { method: 'POST', body: { cart, board: board.id, idx }, auth: false });
    else await api('/buy/hold', { method: 'POST', body: { cart, board: board.id, idx }, auth: false });
  } catch (ex) {
    toast(ex.message);
  } finally {
    busy.delete(key);
    await load(true).catch(() => {});
  }
});

$('#cartClear').addEventListener('click', async () => {
  await api('/buy/release', { method: 'POST', body: { cart }, auth: false }).catch(() => {});
  await load(true);
});

$('#cartCheckout').addEventListener('click', () => {
  const holds = myHolds();
  if (!holds.length) return;
  const cfg = data.config;
  const n = holds.length;
  modalOpen = true;
  renderCart();
  $('#modalBody').innerHTML = `
    <h2>Your squares</h2>
    <p class="muted" style="margin-top:0">${esc(holds.map((h) => sqLabel(h.board, h.idx)).join(', '))}</p>
    <div class="amount">${money(n * cfg.price_cents)}</div>
    <form id="orderForm" class="stack" autocomplete="on" style="margin-top:12px">
      <div class="form-grid">
        <label class="field"><span>Your name</span><input type="text" name="buyer_name" autocomplete="name" required maxlength="60" placeholder="First and last name"></label>
        <label class="field"><span>Phone or email</span><input type="text" name="contact" autocomplete="email" required maxlength="80" placeholder="So we can reach you if you win"></label>
      </div>
      <p class="small muted" style="margin:0">Next you'll pay with Venmo. Your squares are saved for ${cfg.reserve_minutes} minutes while you pay,
        and are yours once the PTA sees your payment.</p>
      <div class="msg error hidden" id="orderErr" role="alert"></div>
      <div class="row">
        <button class="btn" type="button" id="back">← Back</button>
        <span style="flex:1"></span>
        <button class="btn primary big" type="submit">Reserve and pay →</button>
      </div>
    </form>`;
  $('#modal').classList.remove('hidden');
  const close = () => { modalOpen = false; $('#modal').classList.add('hidden'); renderCart(); };
  $('#back').addEventListener('click', close);
  $('#orderForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const err = $('#orderErr');
    err.classList.add('hidden');
    f.querySelector('[type=submit]').disabled = true;
    try {
      const res = await api('/buy/order', {
        method: 'POST',
        auth: false,
        body: { cart, expect: holds.map((h) => [h.board, h.idx]), buyer_name: f.buyer_name.value, contact: f.contact.value },
      });
      newCart();
      location.href = `/?me=${res.token}`;
    } catch (ex) {
      f.querySelector('[type=submit]').disabled = false;
      let msg = ex.message;
      if (ex.data?.lost?.length) msg += ` (${ex.data.lost.map(([b, i]) => sqLabel(b, i)).join(', ')}) Go back and pick others.`;
      err.textContent = msg;
      err.classList.remove('hidden');
      await load(true).catch(() => {});
    }
  });
});

load(true).catch((e) => { $('#app').innerHTML = `<div class="msg error">${esc(e.message)}</div>`; });
setInterval(() => load(false).catch(() => {}), 3000);
setInterval(() => {
  renderCart();
  if (data && serverNow() >= nextExpiry && !modalOpen) render();
}, 1000);
