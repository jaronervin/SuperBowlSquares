// Shared by all three pages.

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export const money = (cents) =>
  `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

// Square label: board 2, idx 37 -> "B2-37"
export const sqLabel = (board, idx) => `B${board}-${String(idx).padStart(2, '0')}`;

const TOKEN_KEY = 'squares-session';

export function session() {
  try {
    return JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
  } catch {
    return null;
  }
}
export function saveSession(s) {
  try {
    if (s) localStorage.setItem(TOKEN_KEY, JSON.stringify(s));
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode: stays signed in for this page only */
  }
}

export class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `Request failed (${status})`);
    this.status = status;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  const s = session();
  if (auth && s?.token) headers.authorization = `Bearer ${s.token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`/api${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty */
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

let toastTimer;
export function toast(text, ms = 2600) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
}

// Sign-in form used by helper and admin pages. Resolves with the session.
export function signIn(container, { title, wantAdmin }) {
  return new Promise((resolve) => {
    container.innerHTML = `
      <form class="card login stack" autocomplete="off">
        <h2>${esc(title)}</h2>
        <label class="field"><span>Your name</span>
          <input type="text" name="name" required maxlength="40" placeholder="e.g. Sam">
        </label>
        <label class="field"><span>Passcode</span>
          <input type="password" name="pin" required inputmode="text">
        </label>
        <div class="msg error hidden" role="alert"></div>
        <button class="btn primary big" type="submit">Sign in</button>
      </form>`;
    const form = container.querySelector('form');
    const err = form.querySelector('.msg');
    const last = session();
    if (last?.name) form.name.value = last.name;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.classList.add('hidden');
      try {
        const s = await api('/login', {
          method: 'POST',
          auth: false,
          body: { name: form.name.value, pin: form.pin.value },
        });
        if (wantAdmin && s.role !== 'admin') throw new Error('That is the helper passcode. The admin screen needs the admin passcode.');
        saveSession(s);
        resolve(s);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
      }
    });
  });
}

/**
 * Render a 10x10 board.
 * opts.cols / opts.rows: digit arrays or null (not drawn yet)
 * opts.cell(idx): { cls, html, button, title }
 * opts.hitCols / hitRows: Set of column/row positions to outline
 */
export function boardHtml({ topName, sideName, cols, rows, cell }) {
  let html = `<div class="board" role="grid">`;
  html += `<div class="team-top">${esc(topName)}</div>`;
  html += `<div class="team-side">${esc(sideName)}</div>`;
  html += `<div style="grid-column:2;grid-row:2"></div>`;
  for (let c = 0; c < 10; c++) {
    html += `<div class="digit col ${cols ? '' : 'blank'}" style="grid-column:${c + 3};grid-row:2">${cols ? cols[c] : '?'}</div>`;
  }
  for (let r = 0; r < 10; r++) {
    html += `<div class="digit row ${rows ? '' : 'blank'}" style="grid-column:2;grid-row:${r + 3}">${rows ? rows[r] : '?'}</div>`;
    for (let c = 0; c < 10; c++) {
      const idx = r * 10 + c;
      const x = cell(idx);
      const tag = x.button ? 'button' : 'div';
      const attrs = x.button ? ` type="button" data-idx="${idx}"` : '';
      html += `<${tag} class="sq ${x.cls || ''}"${attrs} style="grid-column:${c + 3};grid-row:${r + 3}"${
        x.title ? ` title="${esc(x.title)}" aria-label="${esc(x.title)}"` : ''
      }>${x.html || ''}</${tag}>`;
    }
  }
  return html + `</div>`;
}

// Winning square for a finished quarter on a drawn board.
export function winningIdx(board, q) {
  if (!board.cols || !board.rows || !q?.done) return null;
  return board.rows.indexOf(q.side % 10) * 10 + board.cols.indexOf(q.top % 10);
}

export function scoresHtml(scores, topName, sideName) {
  const boxes = scores.quarters
    .map(
      (q) => `<div class="qbox ${q.done ? '' : 'pending'}">
        <div class="q">Q${q.q}</div>
        <div class="s">${q.done ? `${q.top}–${q.side}` : '–'}</div>
      </div>`,
    )
    .join('');
  let live = '';
  if (scores.live && scores.live.state === 'in') {
    live = `<div class="live"><strong>Live:</strong> ${esc(topName)} ${scores.live.top}, ${esc(sideName)} ${scores.live.side} · ${esc(scores.live.detail)}</div>`;
  } else if (scores.live && scores.live.state === 'post') {
    live = `<div class="live muted">Final: ${esc(topName)} ${scores.live.top}, ${esc(sideName)} ${scores.live.side}. Overtime doesn’t count; Q4 pays on the score at the end of regulation.</div>`;
  }
  return `<div class="scores">${boxes}</div>${live}`;
}
