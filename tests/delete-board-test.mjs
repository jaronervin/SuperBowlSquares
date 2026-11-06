// Run against a fresh local server: delete .wrangler/state, npm run dev, then node tests/delete-board-test.mjs
const B='http://localhost:8787/api'; let fails=0; const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m); if(!c) fails++;};
const call=async(p,{token,body}={})=>{const r=await fetch(B+p,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};};
const ad=(await call('/login',{body:{pin:'admin123',name:'A'}})).data.token;
const h=(await call('/login',{body:{pin:'helper123',name:'H'}})).data.token;
await call('/admin/board/new',{token:ad,body:{}}); // board 2
// one sale spanning boards 1 and 2, one sale only on board 2
for (const [b,i] of [[1,0],[1,1],[2,0]]) await call('/hold',{token:h,body:{cart:'cart-span0001',board:b,idx:i}});
let s=await call('/sell',{token:h,body:{cart:'cart-span0001',expect:[[1,0],[1,1],[2,0]],buyer_name:'Span Person',contact:'1',method:'cash'}}); ok(s.status===200,'spanning sale');
await call('/hold',{token:h,body:{cart:'cart-only0002',board:2,idx:5}});
s=await call('/sell',{token:h,body:{cart:'cart-only0002',expect:[[2,5]],buyer_name:'Only Two',contact:'2',method:'venmo'}}); ok(s.status===200,'board-2-only sale');
ok((await call('/admin/board/delete',{token:h,body:{board:2,confirm:'DELETE 2'}})).status===403,'helper cannot delete');
ok((await call('/admin/board/delete',{token:ad,body:{board:2}})).status===400,'no confirmation refused');
ok((await call('/admin/board/delete',{token:ad,body:{board:2,confirm:'DELETE 1'}})).status===400,'wrong board number refused');
ok((await call('/admin/board/delete',{token:ad,body:{board:2,confirm:'delete 2'}})).status===200,'typed confirmation accepted');
const a=(await call('/admin',{token:ad})).data;
ok(a.boards.map(b=>b.id).join()==='1','board 2 gone');
ok(a.sales.length===1 && a.sales[0].buyer_name==='Span Person' && a.sales[0].square_count===2,'spanning sale kept with 2 squares; board-2-only sale removed');
ok(a.totals.collected_cents===1000 && a.totals.squares===2,'totals now $10 / 2 squares');
// delete the last open board while sales open -> a new one opens
ok((await call('/admin/board/delete',{token:ad,body:{board:1,confirm:'DELETE 1'}})).status===200,'delete board 1');
const a2=(await call('/admin',{token:ad})).data; ok(a2.boards.length===1 && a2.boards[0].status==='open' && a2.sales.length===0,'fresh board opened, no sales left');
const pub=(await call('/public?full=1')).data; ok(pub.boards.length===1,'public page fine');
console.log(fails?fails+' FAILED':'ALL PASSED');

// Numbers are reused: lowest free number first.
{
  const ad2=(await call('/login',{body:{pin:'admin123',name:'A'}})).data.token;
  const ids=async()=>(await call('/admin',{token:ad2})).data.boards.map(b=>b.id).join();
  let cur=(await call('/admin',{token:ad2})).data.boards.map(b=>b.id);
  for (const id of cur) await call('/admin/board/delete',{token:ad2,body:{board:id,confirm:'DELETE '+id}});
  ok(await ids()==='1','after deleting everything, numbering restarts at Board 1');
  await call('/admin/board/new',{token:ad2,body:{}}); await call('/admin/board/new',{token:ad2,body:{}});
  ok(await ids()==='1,2,3','new boards are 1,2,3');
  await call('/admin/board/delete',{token:ad2,body:{board:2,confirm:'DELETE 2'}});
  await call('/admin/board/new',{token:ad2,body:{}});
  ok(await ids()==='1,2,3','deleted Board 2 number is reused');
  const st=(await call('/state',{token:ad2})).data; ok(st.boards.find(b=>b.id===2).squares.every(q=>q.s==='open'),'reused Board 2 starts empty');
  const many=await Promise.all([1,2,3].map(()=>call('/admin/board/new',{token:ad2,body:{}})));
  ok(many.every(r=>r.status===200) && await ids()==='1,2,3,4,5,6','three boards created at once get 4,5,6');
  console.log(fails?fails+' FAILED':'ALL PASSED (reuse)');
}
