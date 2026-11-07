// First-run setup: a few short steps that cover everything a new group needs.
// Each step saves as you go, so stopping halfway loses nothing.
import { $, esc, api, toast } from './common.js?v=26';
import { brandingEditor } from './branding.js?v=26';

const STEPS = ['Name', 'Logo & colors', 'The game', 'Helpers', 'Done'];

export function runWizard(container, cfg) {
  return new Promise((resolve) => {
    const state = {
      step: 0,
      title: cfg.title || '',
      org_name: cfg.org_name || '',
      contact: cfg.contact || '',
      brand: { main: cfg.color_main, accent: cfg.color_accent, title: cfg.title, orgName: cfg.org_name, logoVer: cfg.logo_ver },
      price: Number(cfg.price_cents || 500) / 100,
      venmo_user: cfg.venmo_user || '',
      cashapp_tag: cfg.cashapp_tag || '',
      paypal_id: cfg.paypal_id || '',
      game_date: cfg.game_date || '',
    };

    const save = (body) => api('/admin/config', { method: 'POST', body });
    const finish = async () => {
      await save({ setup_done: '1' }).catch(() => {});
      resolve();
    };

    function shell(inner, { next = 'Next →', back = true, skip = false } = {}) {
      const dots = STEPS.map((s, i) => `<span class="pill ${i === state.step ? 'open' : ''}" style="${i < state.step ? 'opacity:.6' : ''}">${i + 1}. ${s}</span>`).join(' ');
      container.innerHTML = `
        <section class="card wizard stack">
          <div class="row" style="justify-content:space-between">
            <h2 style="margin:0">Set up your fundraiser</h2>
            <button type="button" class="btn sm ghost" id="wzLater">Finish later</button>
          </div>
          <div class="row small" style="gap:6px">${dots}</div>
          <form id="wzForm" class="stack" autocomplete="off">
            ${inner}
            <div class="msg error hidden" id="wzErr" role="alert"></div>
            <div class="row">
              ${back && state.step > 0 ? '<button type="button" class="btn" id="wzBack">← Back</button>' : ''}
              <span style="flex:1"></span>
              ${skip ? '<button type="button" class="btn ghost" id="wzSkip">Skip</button>' : ''}
              <button type="submit" class="btn primary big">${next}</button>
            </div>
          </form>
        </section>`;
      $('#wzLater').addEventListener('click', () => {
        if (confirm('Leave setup for now? What you’ve entered is saved. You can finish it later with “Run setup again” on the admin page.')) finish();
      });
      $('#wzBack')?.addEventListener('click', () => { state.step--; render(); });
      $('#wzSkip')?.addEventListener('click', () => { state.step++; render(); });
    }

    const fail = (msg) => {
      const e = $('#wzErr');
      e.textContent = msg;
      e.classList.remove('hidden');
    };

    function render() {
      window.scrollTo(0, 0);
      const s = state.step;
      if (s === 0) {
        shell(`
          <p style="margin:0">A few quick steps and your page is ready. You can change all of it later on the admin page.</p>
          <label class="field"><span>Name of your fundraiser (shown at the top of every page)</span>
            <input type="text" name="title" required maxlength="80" value="${esc(state.title)}" placeholder="e.g. GHEMS Super Bowl Squares"></label>
          <label class="field"><span>Your organization</span>
            <input type="text" name="org_name" maxlength="80" value="${esc(state.org_name)}" placeholder="e.g. GHEMS PTA"></label>
          <label class="field"><span>Contact for questions (email or phone, shown publicly)</span>
            <input type="text" name="contact" maxlength="120" value="${esc(state.contact)}" placeholder="e.g. pta@school.org"></label>`);
        $('#wzForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = e.target;
          Object.assign(state, { title: f.title.value.trim(), org_name: f.org_name.value.trim(), contact: f.contact.value.trim() });
          Object.assign(state.brand, { title: state.title, orgName: state.org_name });
          try {
            await save({ title: state.title, org_name: state.org_name, contact: state.contact });
            state.step++;
            render();
          } catch (ex) { fail(ex.message); }
        });
      } else if (s === 1) {
        shell(`<p style="margin:0" class="small muted">Add your logo and we’ll suggest colors from it. No logo handy? Skip it.
            Your initials show instead, and you can add a logo anytime.</p><div id="wzBrand"></div>`, { skip: true });
        brandingEditor($('#wzBrand'), state.brand);
        $('#wzForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          if (document.querySelector('.cropper')) return fail('Tap “Use this logo” (or Cancel) first.');
          try {
            await save({ color_main: state.brand.main, color_accent: state.brand.accent });
            state.step++;
            render();
          } catch (ex) { fail(ex.message); }
        });
      } else if (s === 2) {
        shell(`
          <div class="form-grid">
            <label class="field"><span>Price per square ($)</span>
              <input type="number" name="price" min="1" step="1" required value="${esc(state.price)}"></label>
            <label class="field"><span>Game date</span>
              <input type="date" name="game_date" value="${esc(state.game_date)}"></label>
          </div>
          <p style="margin:0"><strong>How do you take payments?</strong> Fill in the apps you use and leave the others blank.</p>
          <div class="form-grid">
            <label class="field"><span>Cash App $cashtag</span>
              <input type="text" name="cashapp_tag" maxlength="60" value="${esc(state.cashapp_tag ? '$' + state.cashapp_tag : '')}" placeholder="e.g. $FriendsofGHEMS" autocapitalize="off"></label>
            <label class="field"><span>Venmo username</span>
              <input type="text" name="venmo_user" maxlength="60" value="${esc(state.venmo_user ? '@' + state.venmo_user : '')}" placeholder="e.g. @GHEMS-PTA" autocapitalize="off"></label>
          </div>
          <label class="field"><span>PayPal.me link or PayPal email</span>
            <input type="text" name="paypal_id" maxlength="120" value="${esc(state.paypal_id)}" placeholder="e.g. paypal.me/FriendsofGHEMS" autocapitalize="off"></label>
          <p class="small muted" style="margin:0">Each app you add gets a code at the sign-up table that opens it with the amount filled in. Cash is always an option too.
            The teams fill in on their own once the matchup is set (or pick them on the admin page with “Find the game on ESPN”).</p>`);
        $('#wzForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const f = e.target;
          Object.assign(state, {
            price: Number(f.price.value), game_date: f.game_date.value,
            venmo_user: f.venmo_user.value.trim(), cashapp_tag: f.cashapp_tag.value.trim(), paypal_id: f.paypal_id.value.trim(),
          });
          try {
            await save({
              price_cents: String(Math.round(state.price * 100)), game_date: state.game_date,
              venmo_user: state.venmo_user, cashapp_tag: state.cashapp_tag, paypal_id: state.paypal_id,
            });
            Object.assign(state, { venmo_user: state.venmo_user.replace(/^@/, ''), cashapp_tag: state.cashapp_tag.replace(/^\$/, '') });
            state.step++;
            render();
          } catch (ex) { fail(ex.message); }
        });
      } else if (s === 3) {
        shell(`
          <p style="margin:0">Helpers sign in at the sign-up table with a shared passcode. Set it here, or leave this blank to keep the current one.</p>
          <label class="field"><span>Helper passcode (at least 6 characters)</span>
            <input type="text" name="helper" minlength="6" autocomplete="off" autocapitalize="off"></label>
          <p class="small muted" style="margin:0">Tip: on each tablet, open the sign-up table and use Share → Add to Home Screen.
            It opens full-screen from then on.</p>`);
        $('#wzForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const pin = e.target.helper.value;
          try {
            if (pin) await api('/admin/passcode', { method: 'POST', body: { role: 'helper', new: pin } });
            state.step++;
            render();
          } catch (ex) { fail(ex.message); }
        });
      } else {
        const origin = location.origin;
        shell(`
          <p style="margin:0"><strong>You’re all set.</strong> Here’s where everything lives:</p>
          <ul style="margin:0;padding-left:1.2em">
            <li><strong>Share with everyone:</strong> <a href="/" target="_blank" rel="noopener">${esc(origin)}/</a></li>
            <li><strong>Sign-up table (helpers):</strong> <a href="/helper" target="_blank" rel="noopener">${esc(origin)}/helper</a></li>
            <li><strong>Admin (you):</strong> ${esc(origin)}/admin</li>
          </ul>
          <p class="small muted" style="margin:0">Online sales are off until you turn them on under “Online orders” on the admin page.</p>`,
          { next: 'Finish' });
        $('#wzForm').addEventListener('submit', (e) => {
          e.preventDefault();
          toast('Setup finished.');
          finish();
        });
      }
    }
    render();
  });
}
