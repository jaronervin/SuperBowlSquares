import { $, esc, api, boardHtml, winningIdx, scoresHtml, sqLabel, fitBoard, onResize } from './common.js?v=10';

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
  if (me) {
    const hello = $('#hello');
    hello.classList.remove('hidden');
    if (mine) {
      const list = mine.map(([b, i]) => sqLabel(b, i)).join(', ');
      hello.innerHTML = `<h2>Hi ${esc(meName)}!</h2>
        <p>Your squares are outlined in blue: <strong>${esc(list)}</strong>.
        Save this link to check back during the game.</p>`;
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
      const cls = [name ? 'sold' : 'open', mineSet.has(`${board.id}:${idx}`) ? 'me' : '', w ? 'win' : '']
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
}

onResize(() => fitBoard($('#board .board')));

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
