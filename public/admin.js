import { $, esc, api, money, toast, signIn, session, saveSession, sqLabel } from './common.js?v=29';
import { brandingEditor } from './branding.js?v=29';
import { runWizard } from './wizard.js?v=29';
import { METHOD_LABEL } from './pay.js?v=29';

let data = null;
let saleFilter = '';
let espn = null; // { date, games } from “Find the game on ESPN”, or { error }
// Branding edits in progress survive the page redrawing (e.g. after confirming an order).
let brandDraft = null;
let brandDirty = false;
let wizardActive = false;
const brandBusy = () => wizardActive || brandDirty || document.querySelector('.cropper');

async function openWizard() {
  wizardActive = true;
  await runWizard($('#app'), data.config);
  wizardActive = false;
  // Reload so the whole page picks up the new name, colors and logo.
  location.reload();
}

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
  if (wizardActive) return;
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
    ${totals.waiting_cents ? `<div class="stat"><div class="k">Online, not confirmed</div><div class="v">${money(totals.waiting_cents)}</div></div>` : ''}
    <div class="stat"><div class="k">Refunds still owed</div><div class="v">${money(totals.refunds_owed_cents)}</div></div>
    <div class="stat"><div class="k">Refunded</div><div class="v">${money(totals.refunded_cents)}</div></div>
  </div></section>`;

  h += onlineHtml(data);

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
    actions += ` <button class="btn sm ghost" style="color:var(--danger)" data-act="delete-board" data-board="${b.id}">Delete</button>`;
    h += `<tr>
      <td><strong>${b.id}</strong></td>
      <td><span class="pill ${b.status}">${status}</span>${b.held ? ` <span class="small muted">${b.held} held</span>` : ''}${b.pending ? ` <span class="small muted">${b.pending} online, not confirmed</span>` : ''}</td>
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
      <div class="row">
        <button class="btn sm" data-act="find-game">Find the game on ESPN</button>
        <button class="btn sm" data-act="refresh-scores">Check ESPN now</button>
      </div>
    </div>
    ${espnHtml(cfg)}
    <p class="small muted">${cfg.top_abbr && cfg.side_abbr
      ? `Live scores: <strong>${esc(cfg.top_abbr)}</strong> (top) vs <strong>${esc(cfg.side_abbr)}</strong> (side) on ${esc(cfg.game_date || 'no date set')}.`
      : `No teams picked yet. On game day the app picks them itself if ESPN lists only one game that day (always true for the Super Bowl), or pick them now with “Find the game on ESPN”.`}</p>
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
      <div class="row">
        <input type="text" id="saleFilter" placeholder="Search name, contact, helper" style="max-width:280px" value="${esc(saleFilter)}">
        <button class="btn sm" data-act="download">Download sales</button>
        <button class="btn sm" data-act="download-list">Download mailing list (${mailingList().length})</button>
      </div>
    </div>
    <div class="table-wrap"><table><thead><tr><th>When</th><th>Buyer</th><th>Contact</th><th>Squares</th><th class="num">Amount</th><th>Paid by</th><th>Helper</th><th></th></tr></thead><tbody>
    ${shown
      .map(
        (s) => `<tr><td class="small">${when(s.created_at)}</td>
        <td><strong>${esc(s.buyer_name)}</strong>${s.mailing_list ? ' <span class="pill drawn" title="Asked to join the mailing list">✉ list</span>' : ''}${s.note ? `<div class="small muted">${esc(s.note)}</div>` : ''}</td>
        <td>${esc(s.contact)}</td>
        <td class="small">${s.squares.map(([b, i]) => sqLabel(b, i)).join(', ')}</td>
        <td class="num">${money(s.unit_cents * s.square_count)}</td>
        <td>${esc(METHOD_LABEL[s.method] || s.method)}${s.source === 'online' ? `<div class="small muted">online · ${esc(s.code)}</div>` : ''}</td>
        <td class="small">${esc(s.helper || '')}</td>
        <td class="row" style="justify-content:flex-end;flex-wrap:nowrap">
          <a class="btn sm" href="/?me=${esc(s.token)}" target="_blank" rel="noopener">Link</a>
          <button class="btn sm ghost" data-act="void" data-sale="${s.id}" data-name="${esc(s.buyer_name)}">Void</button>
        </td></tr>`,
      )
      .join('')}
    </tbody></table></div></section>`;

  // ---- branding
  if (!brandDraft) {
    brandDraft = { main: cfg.color_main, accent: cfg.color_accent, title: cfg.title, orgName: cfg.org_name,
      logoVer: cfg.logo_ver, contact: cfg.contact, about: cfg.about_text };
  }
  h += `<section class="card" id="branding"><div class="row" style="justify-content:space-between">
      <h2 style="margin:0">Branding</h2>
      <button class="btn sm ghost" data-act="wizard">Run setup again</button></div>
    <form id="brandForm" class="stack" style="margin-top:10px">
      <div class="form-grid">
        <label class="field"><span>Organization name (e.g. GHEMS PTA)</span><input type="text" name="org_name" maxlength="120" value="${esc(brandDraft.orgName)}"></label>
        <label class="field"><span>Contact for questions (email or phone, shown publicly)</span><input type="text" name="contact" maxlength="120" value="${esc(brandDraft.contact)}"></label>
      </div>
      <label class="field"><span>About this fundraiser (optional, shown on the public page)</span><textarea name="about_text" maxlength="600">${esc(brandDraft.about)}</textarea></label>
      <div id="brandEditor"></div>
      <div class="row"><button class="btn primary" type="submit">Save branding</button>
        ${brandDirty ? '<span class="small muted">Unsaved changes</span>' : ''}</div>
    </form></section>`;

  // ---- settings
  // Payment names are saved without $ / @; show them the way people know them.
  const display = (k) => {
    if (k === 'cashapp_tag' && cfg[k]) return '$' + cfg[k];
    if (k === 'venmo_user' && cfg[k]) return '@' + cfg[k];
    return cfg[k] ?? '';
  };
  const field = (k, label, type = 'text', extra = '') =>
    `<label class="field"><span>${label}</span><input type="${type}" name="${k}" value="${esc(display(k))}" ${extra}></label>`;
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
        ${field('cashapp_tag', 'Cash App $cashtag (e.g. $FriendsofGHEMS)')}
        ${field('venmo_user', 'Venmo username (e.g. @GHEMS-PTA)')}
        ${field('paypal_id', 'PayPal.me link or PayPal email')}
        ${field('online_max', 'Most squares in one online order', 'number', 'min="1" max="100"')}
        ${field('reserve_minutes', 'Minutes an online buyer has to pay', 'number', 'min="5" max="240"')}
        ${field('confirm_hours', 'Hours to confirm an online payment before its squares go back on sale', 'number', 'min="1" max="168"')}
      </div>
      ${field('prize_text', 'Prize line on the public page')}
      <p class="small muted" style="margin:0">Changing the price only affects new sales. Fill in only the payment apps you use;
        each one gets a pay code at the sign-up table and a pay button for online orders. Leave the rest blank.</p>

      <div class="stack" style="border-top:1px solid var(--line);padding-top:12px">
        <strong>Emails</strong>
        <div class="small muted">${data.email.ready
          ? `When an online buyer says they paid, a notice goes to the address below. Buyers who give an email get a “You’re in!” email when you confirm their order.${data.email.from ? ` Emails come from <strong>${esc(data.email.from)}</strong>.` : ''}`
          : 'Emails aren’t switched on for this site yet (the email key is missing), so none will be sent.'}</div>
        <div class="row" style="align-items:flex-end">
          <div style="flex:1;min-width:240px">${field('notify_email', 'Send online-order notices to', 'email', 'placeholder="e.g. pta@school.org"')}</div>
          <button class="btn" type="button" data-act="test-email" ${data.email.ready ? '' : 'disabled'}>Send a test email</button>
        </div>
      </div>
      <div><button class="btn primary" type="submit">Save settings</button></div>
    </form></section>`;

  // ---- passcodes
  h += `<section class="card"><h2>Passcodes</h2>
    <p class="small muted">Changing the helper passcode signs out every helper tablet; tell your helpers the new one.
      Changing yours signs out admins on other devices. At least 6 characters each.</p>
    <div class="form-grid">
      <form class="stack" id="pcHelper" autocomplete="off">
        <strong>Helper passcode</strong>
        <label class="field"><span>New helper passcode</span><input type="text" name="new" minlength="6" required autocomplete="off"></label>
        <div><button class="btn" type="submit">Change helper passcode</button></div>
      </form>
      <form class="stack" id="pcAdmin" autocomplete="off">
        <strong>Your admin passcode</strong>
        <label class="field"><span>Current admin passcode</span><input type="password" name="current" required autocomplete="current-password"></label>
        <label class="field"><span>New admin passcode</span><input type="password" name="new" minlength="6" required autocomplete="new-password"></label>
        <label class="field"><span>New admin passcode again</span><input type="password" name="again" minlength="6" required autocomplete="new-password"></label>
        <div><button class="btn" type="submit">Change admin passcode</button></div>
      </form>
    </div>
  </section>`;

  // ---- start over
  h += `<section class="card"><h2>Start a new year</h2>
    <p class="small muted">Erases every board, sale, refund, prize checkmark and typed-in score, and opens a fresh Board 1.
      Clears the teams and game date. Keeps the title, price, hold time, Venmo username and prize line. Passcodes don't change.</p>
    <button class="btn sm ghost" style="color:var(--danger);border-color:var(--danger)" data-act="new-year">Start a new year…</button>
  </section>`;

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
      if (a === 'delete-board') return confirmDeleteBoard(board);
      if (a === 'download') return downloadSales();
      if (a === 'download-list') return downloadMailingList();
      if (a === 'wizard') return openWizard();
      if (a === 'toggle-online') {
        const on = data.config.online_open === '1';
        if (on && !confirm('Turn off online sales? Orders already placed stay; nobody new can buy online.')) return;
        return act('/admin/config', { online_open: on ? '0' : '1' }, on ? 'Online sales off.' : 'Online sales on.');
      }
      if (a === 'confirm-order') {
        try {
          const r = await api('/admin/order/confirm', { method: 'POST', body: { sale: Number(el.dataset.sale) } });
          toast(`Order ${el.dataset.code} confirmed.${r.emailed ? ` Emailed ${r.emailed}.` : ''}`, 4000);
        } catch (e) {
          toast(e.message, 4000);
        }
        return load();
      }
      if (a === 'test-email') {
        try {
          // Save whatever address is typed in, then send the test there.
          const to = $('#settings').notify_email.value.trim();
          if (!to) return toast('Type an address in “Send online-order notices to” first.', 4000);
          await api('/admin/config', { method: 'POST', body: { notify_email: to } });
          data.config.notify_email = to;
          const r = await api('/admin/email/test', { method: 'POST', body: {} });
          toast(`Test email sent to ${r.to} from ${r.from}. Check that inbox (and spam).`, 6000);
        } catch (e) {
          toast(e.message, 6000);
        }
        return;
      }
      if (a === 'reject-order') {
        if (!confirm(`Reject order ${el.dataset.code}? Its squares go back on sale. If they paid, refund them in Venmo.`)) return;
        return act('/admin/order/reject', { sale: Number(el.dataset.sale) }, `Order ${el.dataset.code} rejected.`);
      }
      if (a === 'new-year') return confirmNewYear();
      if (a === 'find-game') return findGame();
      if (a === 'pick-game') return pickGame(Number(el.dataset.i), el.dataset.top);
      if (a === 'close-espn') { espn = null; return render(); }
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

  $('#pcHelper').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (!confirm('Change the helper passcode? Every helper tablet gets signed out.')) return;
    try {
      await api('/admin/passcode', { method: 'POST', body: { role: 'helper', new: f.new.value } });
      toast('Helper passcode changed. Helpers sign in again with the new one.', 4000);
      f.reset();
    } catch (ex) {
      toast(ex.message, 4000);
    }
  });
  $('#pcAdmin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    if (f.new.value !== f.again.value) return toast('The two new passcodes don’t match.', 4000);
    try {
      const r = await api('/admin/passcode', { method: 'POST', body: { role: 'admin', current: f.current.value, new: f.new.value } });
      saveSession({ ...session(), token: r.token });
      toast('Admin passcode changed.', 4000);
      f.reset();
    } catch (ex) {
      toast(ex.message, 4000);
    }
  });

  const brandForm = $('#brandForm');
  brandingEditor($('#brandEditor'), brandDraft, { onChange: () => { brandDirty = true; } });
  brandForm.addEventListener('input', (e) => {
    const map = { org_name: 'orgName', contact: 'contact', about_text: 'about' };
    if (map[e.target.name]) { brandDraft[map[e.target.name]] = e.target.value; brandDirty = true; }
  });
  brandForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/admin/config', { method: 'POST', body: {
        org_name: brandDraft.orgName, contact: brandDraft.contact, about_text: brandDraft.about,
        color_main: brandDraft.main, color_accent: brandDraft.accent,
      } });
      brandDirty = false;
      brandDraft = null;
      toast('Branding saved. Reload other pages to see it.');
    } catch (ex) {
      toast(ex.message, 4000);
    }
    await load();
  });

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

// Every sale as a spreadsheet (CSV), e.g. to keep a record before starting over.
// Save rows as a spreadsheet (CSV) file.
function saveCsv(rows, name) {
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = rows.map((r) => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// Everyone who asked to join the mailing list, once per email address.
function mailingList() {
  const seen = new Map();
  for (const s of [...data.sales].reverse()) {
    if (!s.mailing_list) continue;
    const email = String(s.contact).trim().toLowerCase();
    if (!seen.has(email)) seen.set(email, { name: s.buyer_name, email: String(s.contact).trim(), when: s.created_at });
  }
  return [...seen.values()];
}

function downloadMailingList() {
  const list = mailingList();
  if (!list.length) return toast('Nobody has asked to join the mailing list yet.');
  const rows = [['Name', 'First name', 'Last name', 'Email', 'Signed up']];
  for (const p of list) {
    const parts = p.name.trim().split(/\s+/);
    rows.push([p.name, parts[0] || '', parts.slice(1).join(' '), p.email, new Date(p.when).toLocaleDateString()]);
  }
  saveCsv(rows, 'mailing-list');
}

function downloadSales() {
  const rows = [['When', 'Buyer', 'Contact', 'Squares', 'Count', 'Amount', 'Paid by', 'Helper', 'Note', 'Mailing list']];
  for (const s of [...data.sales].reverse()) {
    rows.push([
      new Date(s.created_at).toLocaleString(),
      s.buyer_name,
      s.contact,
      s.squares.map(([b, i]) => sqLabel(b, i)).join(' '),
      s.square_count,
      (s.unit_cents * s.square_count / 100).toFixed(2),
      METHOD_LABEL[s.method] || s.method,
      s.helper || '',
      s.note || '',
      s.mailing_list ? 'yes' : '',
    ]);
  }
  saveCsv(rows, 'squares-sales');
}

function confirmNewYear() {
  const { totals, boards, sales } = data;
  const lines = [
    'Start a new year? This erases everything and can’t be undone.',
    '',
    `${boards.length} board${boards.length === 1 ? '' : 's'}, ${sales.length} sale${sales.length === 1 ? '' : 's'} (${money(totals.collected_cents)}) will be erased.`,
  ];
  if (sales.length) lines.push('Tap Cancel and use “Download sales” (and “Download mailing list”) first if you want a record.');
  lines.push('', 'To confirm, type: START OVER');
  const typed = prompt(lines.join('\n'));
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== 'START OVER') {
    toast('Nothing was erased. You need to type START OVER exactly.', 4000);
    return;
  }
  return act('/admin/new-year', { confirm: typed }, 'All set for a new year. Board 1 is open.');
}

// Deleting a board is permanent, so spell out what's on it and make the admin
// type the board number. The server checks the typed text too.
function confirmDeleteBoard(id) {
  const b = data.boards.find((x) => x.id === id);
  let amount = 0;
  const buyers = new Set();
  for (const s of data.sales) {
    const n = s.squares.filter(([bid]) => bid === id).length;
    if (n) {
      amount += n * s.unit_cents;
      buyers.add(`${s.buyer_name}|${s.contact}`);
    }
  }
  const lines = [`Delete Board ${id}? This can't be undone.`, ''];
  if (b.sold) {
    lines.push(
      `It has ${b.sold} sold square${b.sold === 1 ? '' : 's'} from ${buyers.size} ${buyers.size === 1 ? 'person' : 'people'} (${money(amount)}).`,
      'Those sales will be erased. If anyone really paid, refund them yourself.',
    );
  } else {
    lines.push('No squares are sold on it.');
  }
  if (b.status === 'drawn') lines.push('', 'Its numbers are already drawn, so it may be in play.');
  lines.push('', `To confirm, type: DELETE ${id}`);
  const typed = prompt(lines.join('\n'));
  if (typed === null) return;
  if (typed.trim().toUpperCase() !== `DELETE ${id}`) {
    toast(`Not deleted. You need to type DELETE ${id} exactly.`, 4000);
    return;
  }
  return act('/admin/board/delete', { board: id, confirm: typed }, `Board ${id} deleted.`);
}

function espnHtml(cfg) {
  if (!espn) return '';
  if (espn.error) return `<div class="msg error">${esc(espn.error)}</div>`;
  if (!espn.games.length) {
    return `<div class="msg">ESPN doesn't list any games with both teams known on ${esc(espn.date)} yet.</div>`;
  }
  return `<div class="stack" style="margin:10px 0">
    <div class="small muted">Games on ESPN for ${esc(espn.date)}. Pick which team goes across the top:</div>
    ${espn.games
      .map(
        (g, i) => `<div class="row" style="border:1px solid var(--line);border-radius:10px;padding:8px 10px">
          <strong>${esc(g.away.name)} at ${esc(g.home.name)}</strong>
          <span class="small muted">${esc(g.detail)}</span>
          <span style="flex:1"></span>
          <button class="btn sm" data-act="pick-game" data-i="${i}" data-top="away">${esc(g.away.name)} on top</button>
          <button class="btn sm" data-act="pick-game" data-i="${i}" data-top="home">${esc(g.home.name)} on top</button>
        </div>`,
      )
      .join('')}
    <div><button class="btn sm ghost" data-act="close-espn">Close</button></div>
  </div>`;
}

async function findGame() {
  try {
    espn = await api('/admin/espn-games');
  } catch (e) {
    espn = { error: e.message };
  }
  render();
}

function pickGame(i, topSide) {
  const g = espn.games[i];
  const [top, side] = topSide === 'away' ? [g.away, g.home] : [g.home, g.away];
  if (data.boards.some((b) => b.status === 'drawn') &&
      !confirm('Numbers are already drawn. Changing which team is on top changes who wins. Continue?')) return;
  espn = null;
  return act(
    '/admin/config',
    { top_name: top.name, top_abbr: top.abbr, side_name: side.name, side_abbr: side.abbr },
    `${top.name} across the top, ${side.name} down the side.`,
  );
}

// ---- online orders: on/off switch and the orders waiting to be confirmed
function onlineHtml({ config: cfg, orders }) {
  const on = cfg.online_open === '1';
  const STATUS = {
    reserved: 'Not paid yet',
    pending: 'Says they paid',
    rejected: 'Rejected',
    expired: 'Expired',
    cancelled: 'Cancelled by buyer',
  };
  const row = (o, actions) => `<tr>
      <td><strong>${esc(o.code)}</strong><div class="small muted">${when(o.created_at)}</div></td>
      <td><strong>${esc(o.buyer_name)}</strong><div class="small">${esc(o.contact)}</div></td>
      <td class="small">${o.squares.map(([b, i]) => sqLabel(b, i)).join(', ') || '—'}</td>
      <td class="num">${money(o.unit_cents * o.square_count)}</td>
      <td class="small">${STATUS[o.status] || o.status}${o.status === 'pending' ? `<div class="muted">${when(o.paid_at)}</div>` : ''}
        ${o.expires_at && actions ? `<div class="muted">back on sale ${when(o.expires_at)}</div>` : ''}</td>
      <td style="text-align:right;white-space:nowrap">${actions || ''}</td></tr>`;
  const head = '<thead><tr><th>Order</th><th>Buyer</th><th>Squares</th><th class="num">Amount</th><th>Status</th><th></th></tr></thead>';
  let h = `<section class="card" id="online"><div class="row" style="justify-content:space-between">
      <h2 style="margin:0">Online orders${orders.waiting.length ? ` (${orders.waiting.length} waiting)` : ''}</h2>
      <div class="row">
        <span class="pill ${on ? 'open' : 'refund'}">Online sales ${on ? 'on' : 'off'}</span>
        <button class="btn sm" data-act="toggle-online">${on ? 'Turn off' : 'Turn on'}</button>
        ${on ? '<a class="btn sm" href="/buy" target="_blank" rel="noopener">Open buy page</a>' : ''}
      </div></div>`;
  if (!on && !orders.waiting.length) {
    h += `<p class="small muted">When on, people can pick squares at the public page's “Buy squares online” button, reserve them, and pay with Venmo.
      Their squares show as pending until you confirm the payment here.</p>`;
  }
  if (orders.waiting.length) {
    h += `<p class="small muted">Look in Venmo for a payment with the order code in the note. Confirm makes the squares theirs; Reject puts them back on sale.</p>
      <div class="table-wrap"><table>${head}<tbody>${orders.waiting
        .map((o) => row(o, `<button class="btn sm primary" data-act="confirm-order" data-sale="${o.id}" data-code="${esc(o.code)}">Confirm</button>
          <button class="btn sm ghost" style="color:var(--danger)" data-act="reject-order" data-sale="${o.id}" data-code="${esc(o.code)}">Reject</button>`))
        .join('')}</tbody></table></div>`;
  } else if (on) {
    h += `<p class="small muted">No online orders waiting.</p>`;
  }
  if (orders.closed.length) {
    h += `<details style="margin-top:10px"><summary class="small">Recently closed without a sale (${orders.closed.length})</summary>
      <div class="table-wrap"><table>${head}<tbody>${orders.closed.map((o) => row(o, '')).join('')}</tbody></table></div></details>`;
  }
  return h + '</section>';
}

// A brand-new site: claim it with the one-time setup code and pick passcodes.
function claimSite(container) {
  return new Promise((resolve) => {
    container.innerHTML = `
      <form class="card login stack" autocomplete="off">
        <h2>Set up your site</h2>
        <p class="small muted" style="margin:0">Enter the setup code you were given, then choose two passcodes:
          one for you (admin) and one to share with helpers at the sign-up table.</p>
        <label class="field"><span>Setup code</span><input type="text" name="code" required autocapitalize="off"></label>
        <label class="field"><span>Your name</span><input type="text" name="name" required maxlength="40"></label>
        <label class="field"><span>Your admin passcode (at least 6 characters)</span><input type="password" name="admin_pin" minlength="6" required autocomplete="new-password"></label>
        <label class="field"><span>Helper passcode (at least 6 characters, different from yours)</span><input type="text" name="helper_pin" minlength="6" required autocomplete="off"></label>
        <div class="msg error hidden" role="alert"></div>
        <button class="btn primary big" type="submit">Set up</button>
      </form>`;
    const form = container.querySelector('form');
    const err = form.querySelector('.msg');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        const s = await api('/setup/claim', {
          method: 'POST',
          auth: false,
          body: { code: form.code.value, name: form.name.value, admin_pin: form.admin_pin.value, helper_pin: form.helper_pin.value },
        });
        saveSession(s);
        resolve(s);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });
  });
}

async function start() {
  let sess = session();
  const setup = await api('/setup', { auth: false }).catch(() => ({}));
  if (setup.needs_setup) sess = await claimSite($('#app'));
  else if (sess?.role !== 'admin') sess = await signIn($('#app'), { title: 'Admin sign-in', wantAdmin: true });
  $('#who').textContent = sess.name;
  $('#signout').classList.remove('hidden');
  $('#signout').addEventListener('click', () => {
    saveSession(null);
    location.href = '/';
  });
  await load();
  if (data?.config?.setup_done !== '1') openWizard();
  // Keep live scores and winners fresh while the page is open, but don't
  // redraw while someone is typing in a form.
  setInterval(() => {
    const a = document.activeElement;
    if (a && ['INPUT', 'TEXTAREA', 'SELECT'].includes(a.tagName)) return;
    if (brandBusy()) return;
    load().catch(() => {});
  }, 30_000);
}
start();
