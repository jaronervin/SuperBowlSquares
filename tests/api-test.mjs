// Run against a fresh local server: delete .wrangler/state, npm run dev, then node tests/api-test.mjs
const B='http://localhost:8787/api';
let fails=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++;};
async function call(path,{token,body,method}={}){const r=await fetch(B+path,{method:method||(body?'POST':'GET'),headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};}
const wrong=await call('/login',{body:{pin:'nope',name:'X'}}); ok(wrong.status===401,'wrong pin rejected');
const noauth=await call('/state'); ok(noauth.status===401,'state needs auth');
const a=(await call('/login',{body:{pin:'helper123',name:'Ann'}})).data.token;
const b=(await call('/login',{body:{pin:'helper123',name:'Bob'}})).data.token;
const ad=(await call('/login',{body:{pin:'admin123',name:'Boss'}})).data.token;
ok((await call('/admin',{token:a})).status===403,'helper cannot use admin');
const ca='cart-aaaaaaaa', cb='cart-bbbbbbbb';
// race on same square
const [r1,r2]=await Promise.all([call('/hold',{token:a,body:{cart:ca,board:1,idx:5}}),call('/hold',{token:b,body:{cart:cb,board:1,idx:5}})]);
ok([r1.status,r2.status].sort().join()==='200,409','exactly one helper gets a contested square: '+r1.status+','+r2.status);
const winnerCart = r1.status===200?ca:cb, winnerTok=r1.status===200?a:b, loserTok=r1.status===200?b:a, loserCart=r1.status===200?cb:ca;
const st=(await call('/state?cart='+loserCart,{token:loserTok})).data; ok(st.boards[0].squares[5].s==='held','other helper sees it held');
const st2=(await call('/state?cart='+winnerCart,{token:winnerTok})).data; ok(st2.boards[0].squares[5].s==='mine','owner sees mine');
// sell with wrong expectation
let s=await call('/sell',{token:winnerTok,body:{cart:winnerCart,expect:[[1,5],[1,6]],buyer_name:'Jaron Ervin',contact:'555-123-4567',method:'venmo'}}); ok(s.status===409,'sell rejects missing square');
s=await call('/sell',{token:winnerTok,body:{cart:winnerCart,expect:[[1,5]],buyer_name:'Jaron Ervin',contact:'555-123-4567',method:'venmo'}}); ok(s.status===200 && s.data.amount_cents===500,'sell 1 square $5');
const tok1=s.data.token;
const pub=(await call('/public?me='+tok1)).data; ok(pub.boards[0].names[5]==='Jaron E.','public shows short name'); ok(JSON.stringify(pub.mine)==='[[1,5]]','me link finds square');
ok(!JSON.stringify(pub).includes('555'),'public has no contact info'); ok(!JSON.stringify(pub).includes('venmo'),'public has no payment info');
ok((await call('/hold',{token:loserTok,body:{cart:loserCart,board:1,idx:5}})).status===409,'cannot hold sold square');
// release
await call('/hold',{token:a,body:{cart:ca,board:1,idx:7}}); await call('/release',{token:a,body:{cart:ca,board:1,idx:7}});
ok((await call('/hold',{token:b,body:{cart:cb,board:1,idx:7}})).status===200,'released square can be taken'); await call('/release',{token:b,body:{cart:cb}});
// fill the rest of board 1 with Bob, in one order spanning into board 2? board2 doesn't exist yet. fill 99.
const rest=[]; for(let i=0;i<100;i++) if(i!==5) rest.push(i);
await Promise.all(rest.map(i=>call('/hold',{token:b,body:{cart:cb,board:1,idx:i}})));
s=await call('/sell',{token:b,body:{cart:cb,expect:rest.map(i=>[1,i]),buyer_name:'Bob Bigbuyer',contact:'bob@example.com',method:'cash'}}); ok(s.status===200&&s.data.count===99,'sold 99 squares');
let adm=(await call('/admin',{token:ad})).data; ok(adm.boards.length===2 && adm.boards[1].status==='open','board 2 auto-created when board 1 filled');
ok(adm.totals.collected_cents===50000,'total $500 collected');
// draw
const d=await call('/admin/board/draw',{token:ad,body:{board:1}}); ok(d.status===200 && [...d.data.cols].sort().join('')==='0123456789','draw gives permutation');
ok((await call('/admin/board/draw',{token:ad,body:{board:1}})).status===409,'cannot redraw');
ok((await call('/admin/board/draw',{token:ad,body:{board:2}})).status===409,'cannot draw unfilled board');
ok((await call('/admin/sale/void',{token:ad,body:{sale:1}})).status===409,'cannot void sale on drawn board');
// scores -> winner
await call('/admin/score',{token:ad,body:{quarter:1,top:17,side:10}});
const pub2=(await call('/public?full=1')).data; const q1=pub2.scores.quarters[0]; ok(q1.done&&q1.top===17,'manual Q1 score');
adm=(await call('/admin',{token:ad})).data; const w=adm.winners[0]; const b1=pub2.boards[0];
ok(w && b1.cols[w.idx%10]===7 && b1.rows[Math.floor(w.idx/10)]===0,'winner square matches 7/0 digits');
// board 2: partial sale then refund
await call('/hold',{token:a,body:{cart:'cart-cccccccc',board:2,idx:0}}); await call('/hold',{token:a,body:{cart:'cart-cccccccc',board:2,idx:1}});
s=await call('/sell',{token:a,body:{cart:'cart-cccccccc',expect:[[2,0],[2,1]],buyer_name:'Cara',contact:'5551112222',method:'zelle'}}); ok(s.status===200,'sale on board 2');
await call('/admin/config',{token:ad,body:{sales_open:'0'}});
ok((await call('/hold',{token:a,body:{cart:'cart-dddddddd',board:2,idx:3}})).status===409,'no holds when closed');
ok((await call('/admin/board/refund',{token:ad,body:{board:2}})).status===200,'board 2 marked for refund');
adm=(await call('/admin',{token:ad})).data; ok(adm.refunds.length===1 && adm.refunds[0].amount_cents===1000,'refund owed $10 to Cara');
await call('/admin/refund',{token:ad,body:{sale:adm.refunds[0].sale_id,board:2,done:true}});
adm=(await call('/admin',{token:ad})).data; ok(adm.totals.refunded_cents===1000 && adm.totals.refunds_owed_cents===0,'refund marked done');
const pub3=(await call('/public?full=1')).data; ok(pub3.boards.find(x=>x.id===2)?.status==='refund','refunded board shown as refunded on public page');
// hold expiry: set hold minutes 1 and fake? just check extend
console.log(fails? fails+' FAILED':'ALL PASSED');
