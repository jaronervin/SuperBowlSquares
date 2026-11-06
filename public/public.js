import { $, esc, api, money, toast, boardHtml, winningIdx, scoresHtml, sqLabel, fitBoard, onResize, venmoLink, payQrHtml } from './common.js?v=17';

const params = new URLSearchParams(location.search);
const me = params.get('me');
let data = null;
let current = null; // selected board id

async function load(full) {
  const q = new URLSearchParams();
  if (data && !full) q.set('v', data.v);
  if (me) q.set('me', me);
  const res = await api(`/public?${q}`, { auth: false });
  if (res.same) data.scores = res.scores;
  else data = res;
  render();
}

function render() {
  const { config: cfg, boards, scores, mine, meName } = data;
  document.title = cfg.title;
  $('#title').textContent = cfg.title;
  $('#subtitle').textContent = cfg.subtitle;
  $('#prize').textContent = cfg.prize_text;
  $('#how').textContent =
    `Each square wins when the last digit of ${cfg.top_name}'s score matches its column and the last digit of ${cfg.side_name}'s score matches its row, at the end of each quarter. Q4 uses the score at the end of regulation; overtime doesn't count.`;
  $('#scores').classList.remove('muted');
  $('#scores').innerHTML = scoresHtml(scores, cfg.top_name, cfg.side_name);

  const mineSet = new Set((mine || []).map(([b, i]) => `${b}:${i}`));
  const cta = $('#buyCta');
  if (data.online && !(data.order && data.order.status === 'reserved')) {
    cta.classList.remove('hidden');
    cta.innerHTML = `<div class="row" style="justify-content:space-between">
      <div><h2 style="margin:0">Buy squares online</h2><div class="small muted">${money(data.online.price_cents)} a square · pay with Venmo</div></div>
      <a class="btn primary big" href="/buy">Pick your squares →</a></div>`;
  } else {
    cta.classList.add('hidden');
  }
  if (me) {
    const hello = $('#hello');
    hello.classList.remove('hidden');
    const order = data.order;
    if (order && order.status !== 'confirmed') {
      hello.innerHTML = orderHtml(order, meName);
    } else if (mine) {
      const list = mine.map(([b, i]) => sqLabel(b, i)).join(', ');
      hello.innerHTML = `<h2>Hi ${esc(meName)}!</h2>
        <p>Your squares are outlined in blue: <strong>${esc(list)}</strong>.
        Save this link to check back during the game.</p>
        ${order ? `<p class="msg ok" style="margin:0">Payment confirmed ✓ (order ${esc(order.code)})</p>` : ''}`;
    } else {
      hello.innerHTML = `<p>We couldn't find squares for this link. Check that you opened the full link you were sent.</p>`;
    }
  }

  if (!boards.length) {
    $('#board').innerHTML = '<p class="muted">No boards yet.</p>';
    return;
  }
  if (!boards.some((b) => b.id === current)) {
    const myFirst = mine?.[0]?.[0];
    current = boards.some((b) => b.id === myFirst) ? myFirst : boards[0].id;
  }

  $('#tabs').innerHTML = boards
    .map((b) => {
      const sold = b.names.filter(Boolean).length;
      const has = (mine || []).some(([bid]) => bid === b.id);
      return `<button role="tab" data-board="${b.id}" aria-selected="${b.id === current}">
        Board ${b.id}${has ? ' ★' : ''}<span class="count">${b.status === 'drawn' ? '' : b.status === 'refund' ? 'refunded' : `${sold}/100`}</span></button>`;
    })
    .join('');

  const board = boards.find((b) => b.id === current);
  const wins = new Map(); // idx -> [quarters]
  for (const q of scores.quarters) {
    const idx = winningIdx(board, q);
    if (idx != null) wins.set(idx, [...(wins.get(idx) || []), q.q]);
  }
  const sold = board.names.filter(Boolean).length;
  $('#boardInfo').textContent =
    board.status === 'drawn'
      ? `Numbers drawn ${new Date(board.drawn_at).toLocaleString()}.`
      : board.status === 'refund'
        ? `This board didn't fill, so it won't be played. Everyone on it gets their money back.`
        : `${sold} of 100 sold. Numbers are drawn at random once the board is full.`;

  $('#board').innerHTML = boardHtml({
    topName: data.config.top_name,
    sideName: data.config.side_name,
    cols: board.cols,
    rows: board.rows,
    cell: (idx) => {
      const name = board.names[idx];
      const w = wins.get(idx);
      const pend = board.pending?.includes(idx);
      const cls = [name ? (pend ? 'pending' : 'sold') : 'open', mineSet.has(`${board.id}:${idx}`) ? 'me' : '', w ? 'win' : '']
        .filter(Boolean)
        .join(' ');
      const badges = w ? `<span class="badges">${w.map((q) => `<span class="badge">Q${q}</span>`).join('')}</span>` : '';
      return {
        cls,
        html: `${esc(name || '')}${badges}`,
        title: `${sqLabel(board.id, idx)}${name ? `: ${name}` : ': available'}${w ? ` — wins Q${w.join(', Q')}` : ''}`,
      };
    },
  });
  fitBoard($('#board .board'));
  tickOrder();
}

onResize(() => fitBoard($('#board .board')));

// ---- an online order that isn't confirmed yet
const orderNote = (o) => `Squares ${o.squares.map(([b, i]) => sqLabel(b, i)).join(' ')} Order ${o.code}`;
let orderOffset = 0;

function orderHtml(o, name) {
  orderOffset = o.t - Date.now();
  const list = esc(o.squares.map(([b, i]) => sqLabel(b, i)).join(', '));
  const amount = money(o.amount_cents);
  const until = new Date(o.expires_at).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  if (o.status === 'reserved') {
    const user = (o.venmo_user || '').trim().replace(/^@/, '');
    const note = orderNote(o);
    const pay = user
      ? `<a class="btn primary big" href="${esc(venmoLink(user, o.amount_cents, note))}">Pay ${amount} with Venmo</a>
         <div class="small muted">Opens Venmo to <strong>@${esc(user)}</strong> with the amount and this note filled in:
           <span class="memo">${esc(note)}</span></div>
         <details class="small"><summary>On a computer? Scan with your phone instead</summary>
           <div class="pay" style="grid-template-columns:180px;margin-top:8px">${payQrHtml(user, o.amount_cents, note)}</div></details>`
      : `<div class="msg">Ask the organizers how to pay ${amount}, and mention order <strong>${esc(o.code)}</strong>.</div>`;
    return `<h2>Hi ${esc(name)}! Pay to lock in your squares</h2>
      <p style="margin-top:6px">Your squares <strong>${list}</strong> are saved for you for <strong id="orderLeft"></strong> more.</p>
      <div class="stack">
        <div class="amount">${amount}</div>
        ${pay}
        <div class="row"><button class="btn big" type="button" data-act="paid">I’ve sent the payment</button>
          <button class="btn sm ghost" type="button" data-act="cancel">Cancel this order</button></div>
      </div>`;
  }
  if (o.status === 'pending') {
    return `<h2>Thanks, ${esc(name)}!</h2>
      <p>We’re checking for your ${amount} Venmo payment (order <strong>${esc(o.code)}</strong>).
        Your squares <strong>${list}</strong> are saved for you until ${esc(until)}.
        This page will say “confirmed” once it’s done. Save this link.</p>`;
  }
  const why = {
    rejected: 'The organizers cancelled this order.',
    expired: 'This order ran out of time before the payment was confirmed.',
    cancelled: 'You cancelled this order.',
  }[o.status] || 'This order is closed.';
  return `<h2>Order ${esc(o.code)} is closed</h2>
    <p>${why} Its squares went back on sale.${o.status === 'cancelled' ? '' : ' If you already paid, contact the organizers.'}</p>
    <p><a href="/buy">Buy squares</a></p>`;
}

function tickOrder() {
  const el = $('#orderLeft');
  if (!el || !data?.order) return;
  const ms = data.order.expires_at - (Date.now() + orderOffset);
  const s = Math.max(0, Math.ceil(ms / 1000));
  el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
setInterval(tickOrder, 1000);

$('#hello').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  if (b.dataset.act === 'cancel' && !confirm('Cancel this order? Your squares go back on sale.')) return;
  b.disabled = true;
  try {
    await api(b.dataset.act === 'paid' ? '/buy/paid' : '/buy/cancel', { method: 'POST', auth: false, body: { token: me } });
    if (b.dataset.act === 'paid') toast('Thanks! The organizers will confirm your payment.');
  } catch (ex) {
    toast(ex.message, 4000);
  }
  await load(true).catch(() => {});
});

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-board]');
  if (!b) return;
  current = Number(b.dataset.board);
  render();
});

load(true).catch((e) => {
  $('#scores').textContent = e.message;
});
setInterval(() => load(false).catch(() => {}), 15_000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && data) load(false).catch(() => {});
});
