// Payment apps: links that open each app to pay the group, and QR codes for them.
//   Cash App: https://cash.app/$tag/15      amount filled in, note typed by the buyer
//   Venmo:    https://venmo.com/user?...    amount and note filled in
//   PayPal:   https://paypal.me/name/15USD  amount filled in; with only an email, nothing is
import { esc } from './common.js?v=24';

export const PAY_APPS = [
  { id: 'cashapp', label: 'Cash App', key: 'cashapp_tag' },
  { id: 'venmo', label: 'Venmo', key: 'venmo_user' },
  { id: 'paypal', label: 'PayPal', key: 'paypal_id' },
];

export const METHOD_LABEL = { cashapp: 'Cash App', venmo: 'Venmo', paypal: 'PayPal', cash: 'Cash', zelle: 'Zelle', other: 'Other', online: 'Online' };

const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const amountText = (cents) => (cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2));

/** The apps this group has set up: [{ id, label, handle }]. `pay` = { cashapp_tag, venmo_user, paypal_id }. */
export function payOptions(pay = {}) {
  return PAY_APPS.filter((a) => String(pay[a.key] || '').trim()).map((a) => ({ id: a.id, label: a.label, handle: String(pay[a.key]).trim() }));
}

/** How the account is shown to people: $tag, @user, paypal.me/name or the email. */
export function handleText(o) {
  if (o.id === 'cashapp') return `$${o.handle}`;
  if (o.id === 'venmo') return `@${o.handle}`;
  return isEmail(o.handle) ? o.handle : `paypal.me/${o.handle}`;
}

/** A link that opens the app to pay `cents`, or null (PayPal with only an email). */
export function payLink(o, cents, note) {
  const amt = amountText(cents);
  if (o.id === 'cashapp') return `https://cash.app/$${encodeURIComponent(o.handle)}/${amt}`;
  if (o.id === 'venmo') {
    // encodeURIComponent writes spaces as %20 (not +), which Venmo shows as spaces.
    const q = { txn: 'pay', audience: 'private', amount: (cents / 100).toFixed(2), note };
    return `https://venmo.com/${encodeURIComponent(o.handle)}?${Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`;
  }
  if (o.id === 'paypal' && !isEmail(o.handle)) return `https://paypal.me/${encodeURIComponent(o.handle)}/${amt}USD`;
  return null;
}

/** Whether the app fills in the note itself (only Venmo does). */
export const fillsNote = (o) => o.id === 'venmo';

/** QR code (inline SVG) for a link. qrcode() comes from /vendor/qrcode-generator. */
export function qrHtml(url, label) {
  if (!url || typeof qrcode !== 'function') return '';
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return `<div class="qr" role="img" aria-label="${esc(label)} QR code">${qr.createSvgTag({ cellSize: 4, margin: 3, scalable: true })}</div>`;
}
