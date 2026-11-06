// Online orders. Run against a fresh local server: delete .wrangler/state,
// npm run dev, then node tests/online-test.mjs
const B = 'http://localhost:8787/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (p, { token, body } = {}) => {
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
const ad = (await call('/login', { body: { pin: 'admin123', name: 'A' } })).data.token;
const h = (await call('/login', { body: { pin: 'helper123', name: 'Helper' } })).data.token;
const admin = async () => (await call('/admin', { token: ad })).data;

ok((await call('/buy/hold', { body: { cart: 'web-cart-0001', board: 1, idx: 0 } })).status === 409, 'online sales off by default');
await call('/admin/config', { token: ad, body: { online_open: '1', online_max: '3', reserve_minutes: '30', confirm_hours: '24' } });
const st = (await call('/buy/state?cart=web-cart-0001')).data;
ok(st.config.open === true && st.config.price_cents === 500, 'buy page state: open, $5');

for (const i of [10, 11, 12]) ok((await call('/buy/hold', { body: { cart: 'web-cart-0001', board: 1, idx: i } })).status === 200, `online buyer holds square ${i}`);
ok((await call('/buy/hold', { body: { cart: 'web-cart-0001', board: 1, idx: 13 } })).status === 409, 'limit of 3 squares per online order');
ok((await call('/hold', { token: h, body: { cart: 'helper-cart-01', board: 1, idx: 10 } })).status === 409, 'helper cannot take a square the online buyer holds');
ok((await call('/buy/order', { body: { cart: 'web-cart-0001', expect: [[1, 10], [1, 11], [1, 12]], buyer_name: '', contact: 'x' } })).status === 400, 'name required');
let r = await call('/buy/order', { body: { cart: 'web-cart-0001', expect: [[1, 10], [1, 11], [1, 12]], buyer_name: 'Olivia Online', contact: 'olivia@example.com' } });
ok(r.status === 200 && /^[A-Z2-9]{4}$/.test(r.data.code) && r.data.amount_cents === 1500, `reserved: code ${r.data.code}, $15`);
const tok = r.data.token;

let pub = (await call('/public?full=1&me=' + tok)).data;
ok(pub.order.status === 'reserved' && pub.order.amount_cents === 1500 && pub.order.squares.length === 3, 'buyer link shows reserved order');
ok(pub.boards[0].names[10] === 'Olivia O.' && pub.boards[0].pending.includes(10), 'public board shows pending square with name');
ok(pub.online && pub.online.price_cents === 500, 'public page knows online sales are open');
const hs = (await call('/state?cart=x', { token: h })).data;
ok(hs.boards[0].squares[10].s === 'pending', 'helper grid shows pending');
let a = await admin();
ok(a.orders.waiting.length === 1 && a.orders.waiting[0].status === 'reserved', 'admin sees waiting order');
ok(a.totals.collected_cents === 0 && a.totals.waiting_cents === 1500, 'not counted as collected yet');

ok((await call('/buy/paid', { body: { token: tok } })).status === 200, 'buyer taps I have paid');
pub = (await call('/public?full=1&me=' + tok)).data;
ok(pub.order.status === 'pending' && pub.order.expires_at - Date.now() > 23 * 3600_000, 'now pending, held about 24 hours');
ok((await call('/buy/cancel', { body: { token: tok } })).status === 409, 'cannot cancel after saying paid');

ok((await call('/admin/order/confirm', { token: h, body: { sale: a.orders.waiting[0].id } })).status === 403, 'helper cannot confirm');
ok((await call('/admin/order/confirm', { token: ad, body: { sale: a.orders.waiting[0].id } })).status === 200, 'admin confirms');
a = await admin();
ok(a.totals.collected_cents === 1500 && a.sales.length === 1 && a.sales[0].source === 'online', 'confirmed order counts as a sale');
pub = (await call('/public?full=1&me=' + tok)).data;
ok(pub.order.status === 'confirmed' && !pub.boards[0].pending.includes(10), 'buyer sees confirmed; square sold');

// reject path
for (const i of [20, 21]) await call('/buy/hold', { body: { cart: 'web-cart-0002', board: 1, idx: i } });
r = await call('/buy/order', { body: { cart: 'web-cart-0002', expect: [[1, 20], [1, 21]], buyer_name: 'Rex Reject', contact: '4105550000' } });
a = await admin();
await call('/admin/order/reject', { token: ad, body: { sale: a.orders.waiting[0].id } });
pub = (await call('/public?full=1&me=' + r.data.token)).data;
ok(pub.order.status === 'rejected' && pub.boards[0].names[20] === null, 'rejected: squares back on sale');
ok((await call('/hold', { token: h, body: { cart: 'helper-cart-02', board: 1, idx: 20 } })).status === 200, 'helper can sell a rejected square');
await call('/release', { token: h, body: { cart: 'helper-cart-02' } });

// cancel path
await call('/buy/hold', { body: { cart: 'web-cart-0003', board: 1, idx: 30 } });
r = await call('/buy/order', { body: { cart: 'web-cart-0003', expect: [[1, 30]], buyer_name: 'Cal Cancel', contact: '1' } });
ok((await call('/buy/cancel', { body: { token: r.data.token } })).status === 200, 'buyer cancels an unpaid order');
pub = (await call('/public?full=1')).data; ok(pub.boards[0].names[30] === null, 'cancelled square open again');

// expiry path: reserve with a 1-minute window, then wait
await call('/admin/config', { token: ad, body: { reserve_minutes: '1' } });
await call('/buy/hold', { body: { cart: 'web-cart-0004', board: 1, idx: 40 } });
r = await call('/buy/order', { body: { cart: 'web-cart-0004', expect: [[1, 40]], buyer_name: 'Ed Expire', contact: '2' } });
console.log('     waiting 76s for the 1-minute reservation to lapse...');
await new Promise((res) => setTimeout(res, 76_000));
pub = (await call('/public?full=1&me=' + r.data.token)).data;
ok(pub.order.status === 'expired' && pub.boards[0].names[40] === null, 'unpaid reservation expired; square back on sale');
ok((await call('/buy/paid', { body: { token: r.data.token } })).status === 409, 'cannot mark an expired order paid');
a = await admin(); ok(a.orders.closed.length === 3, 'admin lists 3 closed online orders (rejected, cancelled, expired)');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
