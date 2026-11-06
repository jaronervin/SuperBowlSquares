// Turns ESPN's scoreboard JSON into end-of-quarter scores for our two teams.
// Kept separate from the worker so it can be tested on its own.
export function parseEspn(data, cfg) {
  const top = cfg.top_abbr.toUpperCase();
  const side = cfg.side_abbr.toUpperCase();
  for (const ev of data.events || []) {
    const comp = ev.competitions?.[0];
    const teams = comp?.competitors || [];
    const t = teams.find((c) => c.team?.abbreviation?.toUpperCase() === top);
    const s = teams.find((c) => c.team?.abbreviation?.toUpperCase() === side);
    if (!t || !s) continue;
    const status = comp.status || ev.status || {};
    const type = status.type || {};
    const period = Number(status.period || 0);
    const line = (c) => (c.linescores || []).map((l) => Number(l.value ?? l.displayValue ?? 0));
    const tl = line(t);
    const sl = line(s);
    const atEnd = ['STATUS_END_PERIOD', 'STATUS_HALFTIME', 'STATUS_END_OF_REGULATION'].includes(
      type.name,
    );
    const quarters = [1, 2, 3, 4].map((q) => {
      const done = type.state === 'post' || period > q || (period === q && atEnd);
      const sum = (arr) => arr.slice(0, q).reduce((a, b) => a + b, 0);
      // Q4 is the score at the end of regulation: overtime (line 5+) is never added.
      return done ? { q, top: sum(tl), side: sum(sl), done: true, source: 'live' } : { q, done: false };
    });
    return {
      quarters,
      live: {
        top: Number(t.score || 0),
        side: Number(s.score || 0),
        state: type.state,
        detail: type.shortDetail || type.detail || '',
        period,
      },
    };
  }
  throw new Error(`Couldn't find ${top} vs ${side} on ESPN for ${cfg.game_date}`);
}
