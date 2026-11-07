// Emails for online orders, sent through Resend (resend.com) from the group's
// own address at the site's domain. Needs the RESEND_API_KEY secret; without
// it, nothing is sent and the app works as before.
import { themeVars, DEFAULT_MAIN, DEFAULT_ACCENT } from '../public/theme.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());
const money = (cents) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;

export const emailReady = (env) => Boolean(env.RESEND_API_KEY);

/** Send one email. Returns { ok, id } or { ok: false, error }; never throws. */
export async function sendEmail(env, { to, subject, html, text, replyTo, from }) {
  if (!emailReady(env)) return { ok: false, error: 'Email isn’t set up (no RESEND_API_KEY).' };
  try {
    const res = await fetch(`${env.RESEND_BASE || 'https://api.resend.com'}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data.message || `Resend returned ${res.status}` };
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

// "GHEMS PTA <ghems@corkandpin.com>"
export function fromLine(cfg) {
  const name = (cfg.org_name || cfg.title || 'Squares').replace(/["<>]/g, '');
  return `${name} <${cfg.email_from}>`;
}

// A simple branded email: colored header, a few lines, one button.
function layout(cfg, { heading, lines, button, footer }) {
  const v = themeVars(cfg.color_main || DEFAULT_MAIN, cfg.color_accent || DEFAULT_ACCENT);
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:#f4f5f7">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;overflow:hidden;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#14233d">
<tr><td style="background:${v['--brand-dark']};border-bottom:4px solid ${v['--gold']};padding:16px 20px;color:#ffffff;font-size:18px;font-weight:700">${esc(cfg.title || 'Squares')}</td></tr>
<tr><td style="padding:22px 20px 8px;font-size:20px;font-weight:700">${esc(heading)}</td></tr>
${lines.map((l) => `<tr><td style="padding:6px 20px;font-size:15px;line-height:1.5">${l}</td></tr>`).join('')}
${button ? `<tr><td style="padding:16px 20px 8px"><a href="${esc(button.href)}" style="display:inline-block;background:${v['--brand']};color:#ffffff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:10px">${esc(button.label)}</a></td></tr>` : ''}
<tr><td style="padding:16px 20px 20px;font-size:12px;color:#5d6b82">${footer}</td></tr>
</table></td></tr></table></body></html>`;
  return html;
}

const textOf = (heading, lines, button, footer) =>
  [heading, '', ...lines.map((l) => l.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&')), '', button ? `${button.label}: ${button.href}` : '', '', footer.replace(/<[^>]+>/g, '')].join('\n');

const squaresText = (sq) => sq.map(([b, i]) => `B${b}-${String(i).padStart(2, '0')}`).join(', ');

/** To the organizers: a buyer says they paid. */
export function paidNotice(cfg, order, origin) {
  const app = { cashapp: 'Cash App', venmo: 'Venmo', paypal: 'PayPal' }[order.method] || 'an app';
  const heading = `Order ${order.code}: check ${app} for ${money(order.amount_cents)}`;
  const lines = [
    `<strong>${esc(order.buyer_name)}</strong> says they paid <strong>${money(order.amount_cents)}</strong> by <strong>${esc(app)}</strong>.`,
    `Squares: ${esc(squaresText(order.squares))}`,
    `Contact: ${esc(order.contact)}`,
    `Look for a payment from them with order code <strong>${esc(order.code)}</strong> in the note (some people forget the note, so match by name and amount too), then confirm or reject it on the admin page. If nobody does, the squares go back on sale on their own after the time set in Settings.`,
  ];
  const button = { label: 'Open online orders', href: `${origin}/admin#online` };
  const footer = 'Sent because someone placed an online order. Change where these go under Settings on the admin page.';
  return {
    subject: `${order.buyer_name} paid ${money(order.amount_cents)} by ${app} · order ${order.code}`,
    html: layout(cfg, { heading, lines, button, footer }),
    text: textOf(heading, lines, button, footer),
  };
}

/** To the buyer: payment confirmed. */
export function confirmedEmail(cfg, order, origin, kind = 'online') {
  const first = String(order.buyer_name || '').trim().split(/\s+/)[0] || 'there';
  const heading = kind === 'table' ? `Thanks, ${first}!` : `You're in, ${first}!`;
  const lines = [
    kind === 'table'
      ? `Thanks for buying squares${cfg.org_name ? ` and supporting ${esc(cfg.org_name)}` : ''}! Here's what you got (${money(order.amount_cents)}):`
      : `We got your ${money(order.amount_cents)} payment. These squares are yours:`,
    `<strong style="font-size:17px">${esc(squaresText(order.squares))}</strong>`,
    `Use your link to watch the board. The numbers are drawn once the board fills, and winners show up there during the game. Save this email so you can find it.`,
  ];
  if (cfg.prize_text) lines.push(esc(cfg.prize_text));
  const button = { label: 'See my squares', href: `${origin}/?me=${order.token}` };
  const footer = `${esc(cfg.org_name || cfg.title || '')}${cfg.contact ? ` · Questions? ${esc(cfg.contact)}` : ' · Questions? Just reply to this email.'}`;
  return {
    subject: kind === 'table' ? `Your squares for ${cfg.title || 'the game'}` : `You're in! Your squares for ${cfg.title || 'the game'}`,
    html: layout(cfg, { heading, lines, button, footer }),
    text: textOf(heading, lines, button, footer),
  };
}

/** A test from the admin page. */
export function testEmail(cfg, origin) {
  const heading = 'Email is working';
  const lines = [
    `This is a test from <strong>${esc(cfg.title || 'your squares site')}</strong>.`,
    `Payment notices for online orders will arrive at this address. Buyers get their “You're in!” email from <strong>${esc(fromLine(cfg))}</strong>.`,
  ];
  const button = { label: 'Open the admin page', href: `${origin}/admin` };
  const footer = 'Sent from the admin page’s “Send a test email” button.';
  return { subject: `Test email from ${cfg.title || 'your squares site'}`, html: layout(cfg, { heading, lines, button, footer }), text: textOf(heading, lines, button, footer) };
}
