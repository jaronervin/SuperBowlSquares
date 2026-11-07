// Emails, against a stand-in for Resend. Run with .dev.vars containing
// RESEND_API_KEY=re_test and RESEND_BASE=http://localhost:8789, a mock server on
// 8789 writing each request as a JSON line to the file in MOCK_LOG. Local addresses
// have no subdomain, so first set the sender directly:
//   npx wrangler d1 execute squares --local --command "UPDATE config SET value='ghems@corkandpin.com' WHERE key='email_from'"
import { readFileSync } from 'node:fs';
const B = 'http://localhost:8787/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (p, { token, body } = {}) => {
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
const sent = () => readFileSync(process.env.MOCK_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const ad = (await call('/login', { body: { pin: 'admin123', name: 'A' } })).data.token;

let a = (await call('/admin', { token: ad })).data;
ok(a.email.ready === true, 'admin sees email is set up');
ok((await call('/admin/email/test', { token: ad, body: {} })).status === 400, 'test email asks for a notices address first');
ok((await call('/admin/config', { token: ad, body: { notify_email: 'not an email' } })).status === 400, 'bad address refused');
await call('/admin/config', { token: ad, body: { notify_email: 'ghemslions@gmail.com', org_name: 'GHEMS PTA', title: 'GHEMS Super Bowl Squares', contact: 'ghemslions@gmail.com', online_open: '1', cashapp_tag: 'FriendsofGHEMS' } });
const t = await call('/admin/email/test', { token: ad, body: {} });
ok(t.status === 200 && t.data.to === 'ghemslions@gmail.com', 'test email sent');
let m = sent().at(-1);
ok(m.auth === 'Bearer re_test' && m.to[0] === 'ghemslions@gmail.com' && m.from === 'GHEMS PTA <ghems@corkandpin.com>', `test: from "${m.from}" to ${m.to[0]}`);

// online order paid -> organizer notice
await call('/buy/hold', { body: { cart: 'web-cart-mail1', board: 1, idx: 7 } });
await call('/buy/hold', { body: { cart: 'web-cart-mail1', board: 1, idx: 8 } });
const r = await call('/buy/order', { body: { cart: 'web-cart-mail1', expect: [[1, 7], [1, 8]], buyer_name: 'Olivia Online', contact: 'olivia@example.com' } });
const before = sent().length;
await call('/buy/paid', { body: { token: r.data.token, method: 'cashapp' } });
await wait(1500);
m = sent().at(-1);
ok(sent().length === before + 1 && m.to[0] === 'ghemslions@gmail.com', 'organizer notified when buyer says paid');
ok(/Olivia Online paid \$10 by Cash App · order [A-Z2-9]{4}/.test(m.subject) && m.reply_to === 'olivia@example.com', `notice subject "${m.subject}", reply-to buyer`);
ok(m.html.includes('B1-07, B1-08') && m.html.includes('/admin#online') && m.text.includes('B1-07'), 'notice lists squares and links to the admin page');

// confirm -> buyer email
a = (await call('/admin', { token: ad })).data;
const c = await call('/admin/order/confirm', { token: ad, body: { sale: a.orders.waiting[0].id } });
await wait(1500);
m = sent().at(-1);
ok(c.data.emailed === 'olivia@example.com' && m.to[0] === 'olivia@example.com', 'buyer emailed on confirm');
ok(m.subject === "You're in! Your squares for GHEMS Super Bowl Squares" && m.reply_to === 'ghemslions@gmail.com' && m.from === 'GHEMS PTA <ghems@corkandpin.com>', 'buyer email: subject, from GHEMS PTA, replies to the PTA');
ok(m.html.includes('/?me=' + r.data.token) && m.html.includes('B1-07, B1-08'), 'buyer email has their personal link and squares');

// phone-only buyer: no email on confirm
await call('/buy/hold', { body: { cart: 'web-cart-mail2', board: 1, idx: 9 } });
const r2 = await call('/buy/order', { body: { cart: 'web-cart-mail2', expect: [[1, 9]], buyer_name: 'Pat Phone', contact: '410-555-0100' } });
await call('/buy/paid', { body: { token: r2.data.token, method: 'cashapp' } });
await wait(1200);
const n = sent().length;
a = (await call('/admin', { token: ad })).data;
const c2 = await call('/admin/order/confirm', { token: ad, body: { sale: a.orders.waiting[0].id } });
await wait(1200);
ok(c2.data.emailed === null && sent().length === n, 'buyer with a phone number gets no email');

// In-person sales: email buyers get their link right away; mailing list only with an email.
const h = (await call('/login', { body: { pin: 'helper123', name: 'Helper' } })).data.token;
await call('/hold', { token: h, body: { cart: 'helper-cart-m1', board: 1, idx: 40 } });
let before2 = sent().length;
const s1 = await call('/sell', { token: h, body: { cart: 'helper-cart-m1', expect: [[1, 40]], buyer_name: 'Tina Table', contact: 'tina@example.com', method: 'cashapp', mailing_list: true } });
m = sent().at(-1);
ok(s1.data.emailed === 'tina@example.com' && sent().length === before2 + 1, 'table sale with email: link emailed, helper told');
ok(m.subject === 'Your squares for GHEMS Super Bowl Squares' && m.html.includes('Thanks, Tina!') && m.html.includes('/?me=' + s1.data.token), 'table email: "Thanks", squares link');
await call('/hold', { token: h, body: { cart: 'helper-cart-m2', board: 1, idx: 41 } });
before2 = sent().length;
const s2 = await call('/sell', { token: h, body: { cart: 'helper-cart-m2', expect: [[1, 41]], buyer_name: 'Phil Phone', contact: '410-555-0199', method: 'cash', mailing_list: true } });
ok(s2.data.emailed === null && sent().length === before2, 'table sale with phone: no email');
await call('/buy/hold', { body: { cart: 'web-cart-mail3', board: 1, idx: 42 } });
await call('/buy/order', { body: { cart: 'web-cart-mail3', expect: [[1, 42]], buyer_name: 'Olive List', contact: 'olive@example.com', mailing_list: true } });
a = (await call('/admin', { token: ad })).data;
const by = (name) => a.sales.find((x) => x.buyer_name === name) || a.orders.waiting.find((x) => x.buyer_name === name);
ok(by('Tina Table').mailing_list === 1, 'email buyer who checked the box is on the list');
ok(by('Phil Phone').mailing_list === 0, 'phone buyer is never on the list');
ok(by('Olive List').mailing_list === 1, 'online buyer can join the list');
ok(by('Olivia Online').mailing_list === 0, 'unchecked box: not on the list');

console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
