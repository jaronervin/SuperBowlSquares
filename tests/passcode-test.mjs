// Passcodes. Two runs against a fresh local server (delete .wrangler/state first):
//   MODE=existing  with .dev.vars HELPER_PIN=helper123 / ADMIN_PIN=admin123 (an existing site)
//   MODE=new       with .dev.vars SETUP_CODE=setup-123456 only (a brand-new group's site)
const B = 'http://localhost:8787/api';
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
const call = async (p, { token, body } = {}) => {
  const r = await fetch(B + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json() };
};
const login = (pin, name = 'T') => call('/login', { body: { pin, name } });

if (process.env.MODE === 'new') {
  ok((await call('/setup')).data.needs_setup === true, 'new site needs setup');
  ok((await login('anything')).data.needs_setup === true, 'sign-in says not set up');
  ok((await call('/setup/claim', { body: { code: 'wrong', name: 'Pat', admin_pin: 'admin-pass', helper_pin: 'helper-pass' } })).status === 401, 'wrong setup code refused');
  ok((await call('/setup/claim', { body: { code: 'setup-123456', name: 'Pat', admin_pin: '123', helper_pin: 'helper-pass' } })).status === 400, 'short passcode refused');
  ok((await call('/setup/claim', { body: { code: 'setup-123456', name: 'Pat', admin_pin: 'same-pass', helper_pin: 'same-pass' } })).status === 400, 'same passcode for both refused');
  const c = await call('/setup/claim', { body: { code: 'setup-123456', name: 'Pat', admin_pin: 'admin-pass', helper_pin: 'helper-pass' } });
  ok(c.status === 200 && c.data.role === 'admin', 'claimed with setup code, signed in as admin');
  ok((await call('/admin', { token: c.data.token })).status === 200, 'admin token works');
  ok((await call('/setup/claim', { body: { code: 'setup-123456', name: 'X', admin_pin: 'evil-pass1', helper_pin: 'evil-pass2' } })).status === 409, 'setup code cannot be used twice');
  ok((await login('helper-pass')).data.role === 'helper', 'helper passcode works');
  ok((await call('/setup')).data.needs_setup === false, 'no longer needs setup');
} else {
  let ad = (await login('admin123')).data.token;
  const h1 = (await login('helper123')).data.token;
  ok(ad && h1, 'existing Cloudflare passcodes still work');
  ok((await call('/state', { token: h1 })).status === 200, 'helper signed in');
  ok((await call('/admin/passcode', { token: h1, body: { role: 'helper', new: 'new-helper' } })).status === 403, 'helper cannot change passcodes');
  ok((await call('/admin/passcode', { token: ad, body: { role: 'helper', new: '12' } })).status === 400, 'too short refused');
  ok((await call('/admin/passcode', { token: ad, body: { role: 'helper', new: 'admin123' } })).status === 400, 'helper cannot reuse the admin passcode');
  ok((await call('/admin/passcode', { token: ad, body: { role: 'helper', new: 'new-helper' } })).status === 200, 'admin changes helper passcode');
  ok((await call('/state', { token: h1 })).status === 401, 'old helper sign-ins are signed out');
  ok((await call('/admin', { token: ad })).status === 200, 'admin stays signed in');
  ok((await login('helper123')).status === 401, 'old helper passcode no longer works');
  ok((await login('new-helper')).data.role === 'helper', 'new helper passcode works');
  ok((await call('/admin/passcode', { token: ad, body: { role: 'admin', current: 'wrong', new: 'new-admin-1' } })).status === 401, 'admin change needs the current passcode');
  const r = await call('/admin/passcode', { token: ad, body: { role: 'admin', current: 'admin123', new: 'new-admin-1' } });
  ok(r.status === 200 && r.data.token, 'admin passcode changed, fresh sign-in returned');
  ok((await call('/admin', { token: ad })).status === 401, 'old admin sign-in signed out');
  ok((await call('/admin', { token: r.data.token })).status === 200, 'fresh admin sign-in works');
  ok((await login('admin123')).status === 401 && (await login('new-admin-1')).data.role === 'admin', 'old admin passcode refused, new one works');
  ok((await call('/setup')).data.needs_setup === false, 'existing site does not need setup');
}
console.log(fails ? fails + ' FAILED' : 'ALL PASSED');
