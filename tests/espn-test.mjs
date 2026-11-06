import { parseEspn, listGames } from '../src/espn.js';
import { readFileSync } from 'node:fs';
let fails=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++;};
const ls=a=>a.map(v=>({value:v}));
const game=(state,name,period,kc,sf)=>({events:[{competitions:[{status:{period,type:{state,name,shortDetail:'x'}},competitors:[
  {team:{abbreviation:'SF'},score:String(sf.reduce((a,b)=>a+b,0)),linescores:ls(sf)},
  {team:{abbreviation:'KC'},score:String(kc.reduce((a,b)=>a+b,0)),linescores:ls(kc)}]}]},{competitions:[{competitors:[]}]}]});
const cfg={top_abbr:'kc',side_abbr:'SF',game_date:'2024-02-11'};
// Super Bowl LVIII final (OT): KC 0,3,10,6,6 = 25; SF 0,10,0,9,3 = 22
let r=parseEspn(game('post','STATUS_FINAL',5,[0,3,10,6,6],[0,10,0,9,3]),cfg);
ok(r.quarters.map(q=>`${q.top}-${q.side}`).join(' ')==='0-0 3-10 13-10 19-19','OT final: quarters 0-0 3-10 13-10 19-19 (Q4 = end of regulation)');
ok(r.live.top===25 && r.live.side===22,'live total includes OT');
r=parseEspn(game('in','STATUS_IN_PROGRESS',2,[0,3],[0,7]),cfg);
ok(r.quarters[0].done && !r.quarters[1].done,'mid Q2: only Q1 final');
r=parseEspn(game('in','STATUS_HALFTIME',2,[0,3],[0,10]),cfg);
ok(r.quarters[1].done && r.quarters[1].top===3 && !r.quarters[2].done,'halftime: Q2 final');
r=parseEspn(game('in','STATUS_END_PERIOD',4,[0,3,10,6],[0,10,0,9]),cfg);
ok(r.quarters[3].done && r.quarters[3].top===19,'end of regulation before OT: Q4 final at 19-19');
r=parseEspn(game('in','STATUS_IN_PROGRESS',5,[0,3,10,6,3],[0,10,0,9]),cfg);
ok(r.quarters[3].top===19 && r.quarters[3].side===19,'during OT Q4 stays 19-19');
r=parseEspn(game('pre','STATUS_SCHEDULED',0,[],[]),cfg); ok(r.quarters.every(q=>!q.done),'pregame: nothing final');
let threw=false; try{parseEspn(game('pre','x',0,[],[]),{...cfg,side_abbr:'PHI'})}catch{threw=true} ok(threw,'wrong team errors');
// Real ESPN data captured live: Jaguars at Ravens, Nov 5 2026, 3rd quarter.
const real = JSON.parse(readFileSync(new URL('./fixtures/espn-2026-11-05-jax-bal-q3.json', import.meta.url)));
const games = listGames(real);
ok(games.length === 1 && games[0].away.abbr === 'JAX' && games[0].home.abbr === 'BAL' && games[0].away.name === 'Jaguars', 'real data: one game, Jaguars at Ravens');
r = parseEspn(real, { top_abbr: 'JAX', side_abbr: 'BAL', game_date: '2026-11-05' });
ok(r.quarters[0].done && r.quarters[0].top === 10 && r.quarters[0].side === 3, 'real data: Q1 10-3');
ok(r.quarters[1].done && r.quarters[1].top === 17 && r.quarters[1].side === 3, 'real data: Q2 17-3');
ok(!r.quarters[2].done && r.live.state === 'in' && r.live.period === 3, 'real data: Q3 in progress');
console.log(fails?fails+' FAILED':'ALL PASSED');
