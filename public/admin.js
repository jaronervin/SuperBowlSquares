import { $, esc, api, money, toast, signIn, session, saveSession, sqLabel } from './common.js?v=4';

let data = null;
let saleFilter = '';

const METHOD_LABEL = { venmo: 'Venmo', cash: 'Cash', zelle: 'Zelle', other: 'Other' };
const when = (ms) => (ms ? new Date(ms).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '');

async function load() {
  try {
    data = await api('/admin');
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      saveSession(null);
      location.reload();
      return;
    }
    throw e;
  }
  render();
}

async function act(path, body, okMsg) {
  try {
    await api(path, { method: 'POST', body });
    if (okMsg) toast(okMsg);
  } catch (e) {
    toast(e.message, 4000);
  }
  await load();
}

function render() {
  const { config: cfg, boards, sales, refunds, winners, scores, overrides, totals } = data;
  const open = cfg.sales_open === '1';
  const fullUndrawn = boards.filter((b) => b.status === 'open' && b.sold === 100);
  const partial = boards.filter((b) => b.status === 'open' && b.sold < 100);

  let h = '';

  // ---- totals
  h += `<section class="card"><h2>Money</h2><div class="stats">
    <div class="stat"><div class="k">Collected</div><div class="v">${money(totals.collected_cents)}</div></div>
    ${Object.entries(totals.by_method)
      .map(([m, c]) => `<div class="stat"><div class="k">${esc(METHOD_LABEL[m] || m)}</div><div class="v">${money(c)}</div></div>`)
      .join('')}
    <div class="stat"><div class="k">Squares sold</div><div class="v">${totals.squares}</div></div>
    <div class="stat"><div class="k">Refunds still owed</div><div class="v">${money(totals.refunds_owed_cents)}</div></div>
    <div class="stat"><div class="k">Refunded</div><div class="v">${money(totals.refunded_cents)}</div></div>
  </div></section>`;

  // ---- sales switch + boards
  h += `<section class="card"><div class="row" style="justify-content:space-between">
      <h2 style="margin:0">Boards</h2>
      <div class="row">
        <span class="pill ${open ? 'open' : 'refund'}">Sales ${open ? 'open' : 'closed'}</span>
        <button class="btn sm" data-act="toggle-sales">${open ? 'Close sales' : 'Reopen sales'}</button>
        <button class="btn sm" data-act="new-board">+ Add board</button>
      </div>
    </div>`;
  if (!open && partial.length) {
    h += `<div class="msg" style="margin-top:10px">Board${partial.length > 1 ? 's' : ''} ${partial.map((b) => b.id).join(', ')} didn't fill.
      Mark ${partial.length > 1 ? 'them' : 'it'} for refund below, then pay people back from the Refunds list.</div>`;
  }
  h += `<div class="table-wrap"><table><thead><tr><th>Board</th><th>Status</th><th class="num">Sold</th><th>Numbers (top / side)</th><th></th></tr></thead><tbody>`;
  for (const b of boards) {
    const status = b.status === 'drawn' ? 'Numbers drawn' : b.status === 'refund' ? 'Refunding' : b.sold === 100 ? 'Full' : 'Selling';
    let actions = '';
    if (b.status === 'open' && b.sold === 100) actions += `<button class="btn sm primary" data-act="draw" data-board="${b.id}">Draw numbers</button>`;
    if (!open && b.status === 'open' && b.sold < 100) actions += `<button class="btn sm" data-act="refund-board" data-board="${b.id}">Didn't fill: refund</button>`;
    if (b.status === 'refund') actions += `<button class="btn sm" data-act="reopen" data-board="${b.id}">Undo refund</button>`;
    h += `<tr>
      <td><strong>${b.id}</strong></td>
      <td><span class="pill ${b.status}">${status}</span>${b.held ? ` <span class="small muted">${b.held} held</span>` : ''}</td>
      <td class="num">${b.sold}/100</td>
      <td class="small">${b.cols ? `${b.cols.join(' ')}<br>${b.rows.join(' ')}<br><span class="muted">${when(b.drawn_at)}</span>` : '<span class="muted">—</span>'}</td>
      <td style="text-align:right">${actions}</td></tr>`;
  }
  h += `</tbody></table></div>`;
  if (fullUndrawn.length) {
    h += `<p class="small muted">Drawing numbers can't be undone, and the result shows on the public page right away.</p>`;
  }
  h += `</section>`;

  // ---- scores
  const ovr = new Map(overrides.map((o) => [o.quarter, o]));
  h += `<section class="card"><div class="row" style="justify-content:space-between">
      <h2 style="margin:0">Scores</h2>
      <button class="btn sm" data-act="refresh-scores">Check ESPN now</button>
    </div>
    <p class="small muted">${esc(cfg.top_name)} (top) – ${esc(cfg.side_name)} (side), cumulative at the end of each quarter.
      ${scores.fetched_at ? `Last ESPN check ${when(scores.fetched_at)}.` : 'ESPN not checked yet.'}
      ${scores.live ? ` Live: ${scores.live.top}–${scores.live.side}, ${esc(scores.live.detail)}.` : ''}</p>
    ${scores.error ? `<div class="msg error">${esc(scores.error)}</div>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Quarter</th><th>Score</th><th>From</th><th>Fix it by hand</th></tr></thead><tbody>
    ${scores.quarters
      .map((q) => {
        const o = ovr.get(q.q);
        return `<tr><td>Q${q.q}</td>
          <td><strong>${q.done ? `${q.top}–${q.side}` : '—'}</strong></td>
          <td class="small">${q.done ? (q.source === 'manual' ? 'Typed in' : 'ESPN') : ''}</td>
          <td><form class="row score-form" data-q="${q.q}">
            <input type="number" name="top" min="0" style="width:80px" aria-label="${esc(cfg.top_name)} score" value="${o ? o.top : ''}" placeholder="${esc(cfg.top_abbr || 'Top')}">
            <input type="number" name="side" min="0" style="width:80px" aria-label="${esc(cfg.side_name)} score" value="${o ? o.side : ''}" placeholder="${esc(cfg.side_abbr || 'Side')}">
            <button class="btn sm" type="submit">Set</button>
            ${o ? `<button class="btn sm ghost" type="button" data-act="clear-score" data-q="${q.q}">Use ESPN</button>` : ''}
          </form></td></tr>`;
      })
      .join('')}
    </tbody></table></div>
    <p class="small muted">Q4 is the score at the end of regulation. Overtime points are never counted.</p>
  </section>`;

  // ---- winners
  h += `<section class="card"><h2>Winners</h2>`;
  if (!winners.length) h += `<p class="muted">Winners show up here as each quarter ends on boards with numbers drawn.</p>`;
  else {
    h += `<div class="table-wrap"><table><thead><tr><th>Board</th><th>Qtr</th><th>Score</th><th>Square</th><th>Winner</th><th>Contact</th><th>Basket given</th></tr></thead><tbody>
      ${winners
        .map(
          (w) => `<tr><td>${w.board_id}</td><td>Q${w.quarter}</td><td>${esc(w.score)}</td><td>${sqLabel(w.board_id, w.idx)}</td>
          <td><strong>${esc(w.buyer_name)}</strong></td><td>${esc(w.contact)}</td>
          <td><input type="checkbox" data-act="prize" data-board="${w.board_id}" data-q="${w.quarter}" ${w.delivered ? 'checked' : ''} aria-label="Basket given"></td></tr>`,
        )
        .join('')}</tbody></table></div>`;
  }
  h += `</section>`;

  // ---- refunds
  if (refunds.length) {
    h += `<section class="card"><h2>Refunds</h2><p class="small muted">Pay each person back the same way they paid, then tick the box.</p>
      <div class="table-wrap"><table><thead><tr><th>Board</th><th>Buyer</th><th>Contact</th><th>Paid by</th><th class="num">Squares</th><th class="num">Owed</th><th>Refunded</th></tr></thead><tbody>
      ${refunds
        .map(
          (r) => `<tr><td>${r.board_id}</td><td>${esc(r.buyer_name)}</td><td>${esc(r.contact)}</td><td>${esc(METHOD_LABEL[r.method] || r.method)}</td>
          <td class="num">${r.squares}</td><td class="num"><strong>${money(r.amount_cents)}</strong></td>
          <td><input type="checkbox" data-act="refund" data-sale="${r.sale_id}" data-board="${r.board_id}" ${r.done ? 'checked' : ''} aria-label="Refunded"></td></tr>`,
        )
        .join('')}</tbody></table></div></section>`;
  }

  // ---- sales
  const f = saleFilter.toLowerCase();
  const shown = sales.filter((s) => !f || `${s.buyer_name} ${s.contact} ${s.helper}`.toLowerCase().includes(f));
  h += `<section class="card"><div class="row" style="justify-content:space-between">
      <h2 style="margin:0">Sales (${sales.length})</h2>
      <input type="text" id="saleFilter" placeholder="Search name, contact, helper" style="max-width:280px" value="${esc(saleFilter)}">
    </div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Buyer</th><th>Contact</th><th>Squares</th><th class="num">Amount</th><th>Paid by</th><th>Helper</th><th></th></tr></thead><tbody>
    ${shown
      .map(
        (s) => `<tr><td class="small">${when(s.created_at)}</td>
        <td><strong>${esc(s.buyer_name)}</strong>${s.note ? `<div class="small muted">${esc(s.note)}</div>` : ''}</td>
        <td>${esc(s.contact)}</td>
        <td class="small">${s.squares.map(([b, i]) => sqLabel(b, i)).join(', ')}</td>
        <td class="num">${money(s.unit_cents * s.square_count)}</td>
        <td>${esc(METHOD_LABEL[s.method] || s.method)}</td>
        <td class="small">${esc(s.helper || '')}</td>
        <td class="row" style="justify-content:flex-end;flex-wrap:nowrap">
          <a class="btn sm" href="/?me=${esc(s.token)}" target="_blank" rel="noopener">Link</a>
          <button class="btn sm ghost" data-act="void" data-sale="${s.id}" data-name="${esc(s.buyer_name)}">Void</button>
        </td></tr>`,
      )
      .join('')}
    </tbody></table></div></section>`;

  // ---- settings
  const field = (k, label, type = 'text', extra = '') =>
    `<label class="field"><span>${label}</span><input type="${type}" name="${k}" value="${esc(cfg[k] ?? '')}" ${extra}></label>`;
  h += `<section class="card"><h2>Settings</h2>
    <form id="settings" class="stack">
      <div class="form-grid">
        ${field('title', 'Title')}
        ${field('subtitle', 'Subtitle')}
        ${field('top_name', 'Team across the top')}
        ${field('top_abbr', 'Top team ESPN abbreviation (e.g. KC)', 'text', 'maxlength="5"')}
        ${field('side_name', 'Team down the side')}
        ${field('side_abbr', 'Side team ESPN abbreviation (e.g. PHI)', 'text', 'maxlength="5"')}
        ${field('game_date', 'Game date (for live scores)', 'date')}
        <label class="field"><span>Price per square ($)</span><input type="number" name="price_dollars" min="1" step="1" value="${Number(cfg.price_cents) / 100}"></label>
        ${field('hold_minutes', 'Minutes a picked square is held', 'number', 'min="1" max="30"')}
        ${field('venmo_user', 'Venmo username (shown at checkout)')}
      </div>
      ${field('prize_text', 'Prize line on the public page')}
      <div><button class="btn primary" type="submit">Save settings</button></div>
      <p class="small muted">Changing the price only affects new sales.</p>
    </form></section>`;

  $('#app').innerHTML = h;
  bind();
}

function bind() {
  const app = $('#app');
  app.querySelectorAll('[data-act]').forEach((el) => {
    const evt = el.type === 'checkbox' ? 'change' : 'click';
    el.addEventListener(evt, async () => {
      const a = el.dataset.act;
      const board = Number(el.dataset.board);
      if (a === 'toggle-sales') {
        const closing = data.config.sales_open === '1';
        if (closing && !confirm('Close sales? Helpers won’t be able to pick squares, and anything they’re holding is let go.')) return;
        return act('/admin/config', { sales_open: closing ? '0' : '1' }, closing ? 'Sales closed.' : 'Sales reopened.');
      }
      if (a === 'new-board') return act('/admin/board/new', {}, 'Board added.');
      if (a === 'draw') {
        if (!confirm(`Draw the numbers for Board ${board}? This can’t be undone.`)) return;
        return act('/admin/board/draw', { board }, `Numbers drawn for Board ${board}.`);
      }
      if (a === 'refund-board') {
        if (!confirm(`Board ${board} didn't fill. Stop selling it and list its buyers for refunds?`)) return;
        return act('/admin/board/refund', { board }, 'Marked for refund.');
      }
      if (a === 'reopen') return act('/admin/board/reopen', { board }, 'Board reopened for sale.');
      if (a === 'refresh-scores') return act('/admin/refresh-scores', {}, 'Checked ESPN.');
      if (a === 'clear-score') return act('/admin/score', { quarter: Number(el.dataset.q), clear: true }, 'Back to ESPN for that quarter.');
      if (a === 'prize') return act('/admin/prize', { board, quarter: Number(el.dataset.q), done: el.checked });
      if (a === 'refund') return act('/admin/refund', { sale: Number(el.dataset.sale), board, done: el.checked });
      if (a === 'void') {
        if (!confirm(`Void ${el.dataset.name}'s sale? Their squares go back on sale. Refund them yourself if they paid.`)) return;
        return act('/admin/sale/void', { sale: Number(el.dataset.sale) }, 'Sale voided.');
      }
    });
  });

  app.querySelectorAll('.score-form').forEach((form) =>
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      act('/admin/score', { quarter: Number(form.dataset.q), top: form.top.value, side: form.side.value }, 'Score set.');
    }),
  );

  $('#settings').addEventListener('submit', (e) => {
    e.preventDefault();
    const fd = Object.fromEntries(new FormData(e.target));
    fd.price_cents = String(Math.round(Number(fd.price_dollars) * 100));
    delete fd.price_dollars;
    act('/admin/config', fd, 'Settings saved.');
  });

  const filter = $('#saleFilter');
  filter.addEventListener('input', () => {
    saleFilter = filter.value;
    const pos = filter.selectionStart;
    render();
    const again = $('#saleFilter');
    again.focus();
    again.setSelectionRange(pos, pos);
  });
}

async function start() {
  let sess = session();
  if (sess?.role !== 'admin') sess = await signIn($('#app'), { title: 'Admin sign-in', wantAdmin: true });
  $('#who').textContent = sess.name;
  $('#signout').classList.remove('hidden');
  $('#signout').addEventListener('click', () => {
    saveSession(null);
    location.href = '/';
  });
  await load();
  // Keep live scores and winners fresh while the page is open, but don't
  // redraw while someone is typing in a form.
  setInterval(() => {
    const a = document.activeElement;
    if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
    load().catch(() => {});
  }, 30_000);
}
start();
