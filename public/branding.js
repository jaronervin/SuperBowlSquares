// Logo and color tools for the admin page and the setup wizard:
//   - pick a logo from the phone, crop it to a square (drag + pinch or slider),
//     optionally remove a white background, shrink it, upload it
//   - suggest two colors from the logo
//   - pick colors with a live preview that uses the real site styles
import { esc, api, toast } from './common.js?v=29';
import { themeVars, contrast, hexToRgb, rgbToHex, luminance, DEFAULT_MAIN, DEFAULT_ACCENT } from './theme.js?v=29';

const OUT = 512; // saved logo size, square

// ------------------------------------------------------------------ colors from a logo

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * The main colors in an image (canvas or image), biggest first, ignoring
 * transparent areas, white, black and greys. Returns [{ hex, share }].
 */
export function logoColors(source) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, 64, 64);
  const px = ctx.getImageData(0, 0, 64, 64).data;
  const buckets = new Map();
  let counted = 0;
  for (let i = 0; i < px.length; i += 4) {
    if (px[i + 3] < 128) continue;
    const rgb = [px[i], px[i + 1], px[i + 2]];
    const [, s, l] = rgbToHsl(rgb);
    if (l > 0.93 || l < 0.07 || s < 0.15) continue; // background, outlines, greys
    const key = rgb.map((v) => v >> 4).join(',');
    const b = buckets.get(key) || { n: 0, sum: [0, 0, 0] };
    b.n++;
    rgb.forEach((v, k) => (b.sum[k] += v));
    buckets.set(key, b);
    counted++;
  }
  if (!counted) return [];
  // Merge near-identical shades (anti-aliasing, gradients) into the bigger group.
  const groups = [];
  for (const b of [...buckets.values()].sort((x, y) => y.n - x.n)) {
    const avg = b.sum.map((v) => v / b.n);
    const g = groups.find((x) => dist(x.avg, avg) < 48);
    if (g) {
      g.sum = g.sum.map((v, k) => v + b.sum[k]);
      g.n += b.n;
      g.avg = g.sum.map((v) => v / g.n);
    } else {
      groups.push({ n: b.n, sum: [...b.sum], avg });
    }
  }
  return groups
    .sort((x, y) => y.n - x.n)
    .map((g) => ({ hex: rgbToHex(g.avg), share: g.n / counted }))
    .filter((g) => g.share >= 0.03)
    .slice(0, 6);
}

/** A suggested { main, accent } from logo colors. */
export function suggestPair(colors) {
  if (!colors.length) return null;
  const top = colors.filter((c) => c.share >= 0.08);
  const pool = top.length ? top : colors;
  // Main: the darker of the two biggest colors (white text has to read on it).
  let main = pool[0].hex;
  if (pool[1] && pool[1].share >= 0.15 && luminance(pool[1].hex) < luminance(main)) main = pool[1].hex;
  // Accent: the most different remaining color.
  const rest = colors.filter((c) => c.hex !== main);
  let accent = null;
  let best = 0;
  for (const c of rest) {
    const d = dist(hexToRgb(c.hex), hexToRgb(main)) * (0.5 + c.share);
    if (d > best && dist(hexToRgb(c.hex), hexToRgb(main)) > 60) { best = d; accent = c.hex; }
  }
  if (!accent) accent = luminance(main) > 0.4 ? DEFAULT_MAIN : DEFAULT_ACCENT; // one-color logo
  return { main, accent };
}

// ------------------------------------------------------------------ logo cropper

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file doesn’t look like an image. Try a PNG or JPG.'));
    img.src = url;
  });
}

// White (and near-white) pixels become transparent, softly at the edges.
function removeWhite(ctx, size) {
  const d = ctx.getImageData(0, 0, size, size);
  const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const m = Math.min(p[i], p[i + 1], p[i + 2]);
    if (m >= 240) p[i + 3] = 0;
    else if (m >= 215) p[i + 3] = Math.round(p[i + 3] * (240 - m) / 25);
  }
  ctx.putImageData(d, 0, 0);
}

function toDataUrl(canvas) {
  // Keep uploads small: shrink if the PNG is large (photos rather than logos).
  let url = canvas.toDataURL('image/png');
  if (url.length > 650_000) {
    const s = document.createElement('canvas');
    s.width = s.height = 320;
    s.getContext('2d').drawImage(canvas, 0, 0, 320, 320);
    url = s.toDataURL('image/png');
    if (url.length > 650_000) url = s.toDataURL('image/jpeg', 0.85);
  }
  return url;
}

/**
 * Show the crop tool inside `el` for `file`. Resolves with
 * { logo, icon, colors } (data URLs + suggested colors), or null if cancelled.
 */
export function cropLogo(el, file) {
  return new Promise(async (resolve) => {
    let img;
    try {
      img = await loadImage(file);
    } catch (e) {
      toast(e.message, 4000);
      resolve(null);
      return;
    }
    el.innerHTML = `
      <div class="cropper stack">
        <div class="small muted">Drag to move. Pinch or use the slider to zoom. The logo should fill the square.</div>
        <canvas class="crop-view" width="560" height="560" aria-label="Crop your logo"></canvas>
        <label class="field"><span>Zoom</span><input type="range" class="crop-zoom" min="1" max="5" step="0.01" value="1"></label>
        <label class="row small" style="gap:8px"><input type="checkbox" class="crop-white"> Remove white background</label>
        <div class="row"><button type="button" class="btn ghost crop-cancel">Cancel</button><span style="flex:1"></span>
          <button type="button" class="btn primary crop-use">Use this logo</button></div>
      </div>`;
    const view = el.querySelector('.crop-view');
    const ctx = view.getContext('2d', { willReadFrequently: true });
    const V = view.width;
    const fit = Math.min(V / img.width, V / img.height); // whole image visible at zoom 1
    let zoom = 1;
    let cx = img.width / 2; // image point at the center of the square
    let cy = img.height / 2;
    const zoomEl = el.querySelector('.crop-zoom');
    const whiteEl = el.querySelector('.crop-white');

    const drawTo = (c2, size, withChecker) => {
      const g = c2.getContext('2d', { willReadFrequently: true });
      g.clearRect(0, 0, size, size);
      const scale = fit * zoom * (size / V);
      g.imageSmoothingQuality = 'high';
      g.drawImage(img, size / 2 - cx * scale, size / 2 - cy * scale, img.width * scale, img.height * scale);
      if (whiteEl.checked) removeWhite(g, size);
      if (withChecker) {
        g.globalCompositeOperation = 'destination-over';
        const t = 20;
        for (let y = 0; y < size; y += t) for (let x = 0; x < size; x += t) {
          g.fillStyle = (x / t + y / t) % 2 ? '#e9edf3' : '#ffffff';
          g.fillRect(x, y, t, t);
        }
        g.globalCompositeOperation = 'source-over';
      }
    };
    const draw = () => drawTo(view, V, true);

    // Drag with one finger or the mouse; pinch with two fingers.
    const pts = new Map();
    let pinch = null;
    view.style.touchAction = 'none';
    view.addEventListener('pointerdown', (e) => { view.setPointerCapture(e.pointerId); pts.set(e.pointerId, [e.clientX, e.clientY]); });
    view.addEventListener('pointermove', (e) => {
      if (!pts.has(e.pointerId)) return;
      const prev = pts.get(e.pointerId);
      pts.set(e.pointerId, [e.clientX, e.clientY]);
      const ratio = V / view.getBoundingClientRect().width;
      if (pts.size === 1) {
        const scale = fit * zoom;
        cx -= ((e.clientX - prev[0]) * ratio) / scale;
        cy -= ((e.clientY - prev[1]) * ratio) / scale;
      } else if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
        if (pinch) zoom = Math.max(1, Math.min(5, zoom * (d / pinch)));
        pinch = d;
        zoomEl.value = zoom;
      }
      draw();
    });
    const up = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch = null; };
    view.addEventListener('pointerup', up);
    view.addEventListener('pointercancel', up);
    zoomEl.addEventListener('input', () => { zoom = Number(zoomEl.value); draw(); });
    whiteEl.addEventListener('change', draw);
    el.querySelector('.crop-cancel').addEventListener('click', () => { el.innerHTML = ''; resolve(null); });
    el.querySelector('.crop-use').addEventListener('click', () => {
      const out = document.createElement('canvas');
      out.width = out.height = OUT;
      drawTo(out, OUT, false);
      // Home-screen icon: the logo on white with a little breathing room.
      const icon = document.createElement('canvas');
      icon.width = icon.height = OUT;
      const ig = icon.getContext('2d');
      ig.fillStyle = '#ffffff';
      ig.fillRect(0, 0, OUT, OUT);
      ig.drawImage(out, OUT * 0.08, OUT * 0.08, OUT * 0.84, OUT * 0.84);
      resolve({ logo: toDataUrl(out), icon: toDataUrl(icon), colors: logoColors(out) });
    });
    draw();
  });
}

// ------------------------------------------------------------------ preview

/** A miniature of the site in the given colors, using the real styles. */
export function previewHtml({ main, accent, title, logoSrc, initialsText }) {
  const vars = Object.entries(themeVars(main, accent)).map(([k, v]) => `${k}:${v}`).join(';');
  const logo = logoSrc
    ? `<img class="brand-logo" src="${esc(logoSrc)}" alt="">`
    : `<span class="brand-logo badge-initials">${esc(initialsText || '?')}</span>`;
  const sq = (cls, text) => `<div class="sq ${cls}" style="aspect-ratio:1.3/1">${text}</div>`;
  return `<div class="preview" style="${vars};background:var(--bg);border:1px solid var(--line);border-radius:12px;overflow:hidden">
    <div class="top compact" style="padding:8px 12px"><div class="inner" style="gap:10px">${logo}
      <div><h1 style="font-size:1rem">${esc(title || 'Your fundraiser')}</h1><div class="sub">$5 a square</div></div></div></div>
    <div style="padding:10px 12px" class="stack">
      <div style="display:grid;grid-template-columns:22px repeat(4,1fr);gap:3px;max-width:340px">
        <div></div>${[3, 7, 0, 5].map((d) => `<div class="digit col" style="height:24px">${d}</div>`).join('')}
        <div class="digit row">2</div>
        ${sq('sold', 'Pat K.')}${sq('mine', 'Picked')}${sq('win', 'Sam R.')}${sq('open', '')}
      </div>
      <div class="row"><span class="btn primary sm">Take payment →</span><span class="pill open">Open</span>
        <span style="color:var(--gold-text);font-weight:700;font-size:.9rem">Accent text</span></div>
    </div>
  </div>`;
}

/** A note when the colors had to be adjusted for readability. */
export function readabilityNote(main) {
  const v = themeVars(main, DEFAULT_ACCENT);
  if (v['--brand'].toLowerCase() === String(main).toLowerCase()) return '';
  return `Your main color is light, so the site uses a slightly darker shade of it (${v['--brand']}) wherever white text sits on top, to keep it readable.`;
}

// ------------------------------------------------------------------ the editor

/**
 * Logo + colors editor. `state` = { main, accent, title, orgName, logoVer }.
 * onChange(state) fires as colors change; saving is up to the caller, except
 * the logo, which uploads when chosen (or removed).
 */
export function brandingEditor(el, state, { onChange = () => {} } = {}) {
  let suggestions = [];
  let slot = 'main';
  const logoSrc = () => (Number(state.logoVer) > 0 ? `/api/logo?v=${state.logoVer}` : null);
  const initialsFor = () => {
    const words = String(state.orgName || state.title || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) return '?';
    if (/^[A-Z0-9]{2,5}$/.test(words[0])) return words[0];
    return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
  };

  function render() {
    const note = readabilityNote(state.main);
    el.innerHTML = `
      <div class="stack">
        <div class="logo-block stack">
          <strong>Logo</strong>
          <div class="row">
            ${logoSrc() ? `<img src="${logoSrc()}" alt="Current logo" style="width:72px;height:72px;object-fit:contain;border:1px solid var(--line);border-radius:12px;background:#fff">`
              : `<span class="small muted">No logo yet. The site shows your initials instead.</span>`}
            <label class="btn">${logoSrc() ? 'Change logo' : 'Upload logo'}<input type="file" accept="image/*" class="logo-file" hidden></label>
            ${logoSrc() ? '<button type="button" class="btn ghost logo-remove">Remove</button>' : ''}
          </div>
          <div class="small muted">Tip: on the school website or Facebook page, press and hold your logo and choose
            <em>Save to Photos</em> (or <em>Download image</em>), then upload it here.</div>
          <div class="crop-area"></div>
        </div>
        <div class="stack">
          <strong>Colors</strong>
          ${suggestions.length ? `<div class="stack" style="gap:6px">
              <div class="small muted">From your logo. Tap a color to use it as the <strong>${slot === 'main' ? 'main' : 'accent'}</strong> color:</div>
              <div class="row">${suggestions.map((c) => `<button type="button" class="swatch" data-hex="${c.hex}" title="${c.hex}" style="background:${c.hex}"></button>`).join('')}
                <button type="button" class="btn sm suggest">Use suggested pair</button></div>
            </div>` : ''}
          <div class="row" style="gap:16px">
            <label class="color-pick ${slot === 'main' ? 'active' : ''}" data-slot="main"><input type="color" class="c-main" value="${esc(state.main)}"> Main</label>
            <label class="color-pick ${slot === 'accent' ? 'active' : ''}" data-slot="accent"><input type="color" class="c-accent" value="${esc(state.accent)}"> Accent</label>
            <button type="button" class="btn sm ghost swap">Swap</button>
            <button type="button" class="btn sm ghost reset">Default colors</button>
          </div>
          ${note ? `<div class="small muted">${esc(note)}</div>` : ''}
        </div>
        <div class="stack"><strong>Preview</strong>${previewHtml({ main: state.main, accent: state.accent, title: state.title, logoSrc: logoSrc(), initialsText: initialsFor() })}</div>
      </div>`;

    const set = (k, v) => { state[k] = v; onChange(state); render(); };
    el.querySelector('.c-main').addEventListener('input', (e) => { state.main = e.target.value; onChange(state); });
    el.querySelector('.c-main').addEventListener('change', (e) => set('main', e.target.value));
    el.querySelector('.c-accent').addEventListener('input', (e) => { state.accent = e.target.value; onChange(state); });
    el.querySelector('.c-accent').addEventListener('change', (e) => set('accent', e.target.value));
    el.querySelectorAll('.color-pick').forEach((p) => p.addEventListener('click', () => { slot = p.dataset.slot; }));
    el.querySelectorAll('.swatch').forEach((b) => b.addEventListener('click', () => {
      set(slot, b.dataset.hex);
      slot = slot === 'main' ? 'accent' : 'main';
      render();
    }));
    el.querySelector('.suggest')?.addEventListener('click', () => {
      const p = suggestPair(suggestions);
      if (p) { state.main = p.main; state.accent = p.accent; onChange(state); render(); }
    });
    el.querySelector('.swap').addEventListener('click', () => { [state.main, state.accent] = [state.accent, state.main]; onChange(state); render(); });
    el.querySelector('.reset').addEventListener('click', () => { state.main = DEFAULT_MAIN; state.accent = DEFAULT_ACCENT; onChange(state); render(); });
    el.querySelector('.logo-remove')?.addEventListener('click', async () => {
      if (!confirm('Remove the logo? The site shows your initials instead.')) return;
      try {
        await api('/admin/logo/delete', { method: 'POST', body: {} });
        state.logoVer = 0;
        suggestions = [];
        onChange(state);
        render();
      } catch (e) { toast(e.message, 4000); }
    });
    el.querySelector('.logo-file').addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const area = el.querySelector('.crop-area');
      const out = await cropLogo(area, file);
      if (!out) return;
      area.innerHTML = '<div class="small muted">Saving logo…</div>';
      try {
        await api('/admin/logo', { method: 'POST', body: { logo: out.logo, icon: out.icon } });
        state.logoVer = Date.now(); // shows the new image; the server's number is picked up on reload
        suggestions = out.colors;
        slot = 'main';
        // First logo, colors still the defaults: apply the suggestion right away.
        const p = suggestPair(out.colors);
        if (p && state.main === DEFAULT_MAIN && state.accent === DEFAULT_ACCENT) { state.main = p.main; state.accent = p.accent; }
        onChange(state);
        render();
        toast(out.colors.length ? 'Logo saved. Colors from your logo are below.' : 'Logo saved.');
      } catch (ex) {
        area.innerHTML = '';
        toast(ex.message, 4000);
      }
    });
  }
  render();
  // Already have a logo: offer its colors too.
  if (logoSrc()) {
    const img = new Image();
    img.onload = () => { suggestions = logoColors(img); if (suggestions.length) render(); };
    img.src = logoSrc();
  }
  return { render, get state() { return state; } };
}

export { contrast };
