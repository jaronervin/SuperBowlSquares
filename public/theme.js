// Turns a group's two colors (main + accent) into every color the site uses,
// adjusting shades so text stays readable. Shared by the server (which puts
// the colors into each page) and the admin page (for the live preview).

export const DEFAULT_MAIN = '#1d4f91';
export const DEFAULT_ACCENT = '#f5b700';

export function hexToRgb(hex) {
  const m = String(hex || '').trim().replace(/^#/, '');
  const full = m.length === 3 ? m.split('').map((c) => c + c).join('') : m;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
}

export const rgbToHex = (rgb) => `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

export const validColor = (hex) => hexToRgb(hex) !== null;

// t = 0 gives a, t = 1 gives b.
export function mix(a, b, t) {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex(x.map((v, i) => v + (y[i] - v) * t));
}

// WCAG relative luminance and contrast ratio (1 to 21).
export function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Darken (or lighten) a color step by step until it reaches the ratio against bg.
export function ensureContrast(color, bg, ratio, toward = '#000000') {
  let c = color;
  for (let i = 0; i < 20 && contrast(c, bg) < ratio; i++) c = mix(c, toward, 0.1);
  return c;
}

// Black or white, whichever reads better on bg.
export const inkOn = (bg) => (contrast(bg, '#ffffff') >= contrast(bg, '#14181f') ? '#ffffff' : '#14181f');

export function themeVars(mainIn, accentIn) {
  const main = validColor(mainIn) ? rgbToHex(hexToRgb(mainIn)) : DEFAULT_MAIN;
  const accent = validColor(accentIn) ? rgbToHex(hexToRgb(accentIn)) : DEFAULT_ACCENT;
  const brand = ensureContrast(main, '#ffffff', 4.5); // white text and buttons on it
  const brandDark = ensureContrast(mix(brand, '#000000', 0.35), '#ffffff', 7);
  const mine = mix(accent, '#ffffff', 0.72);
  return {
    '--brand': brand,
    '--brand-dark': brandDark,
    '--gold': accent,
    '--gold-ink': inkOn(accent),
    '--gold-text': ensureContrast(accent, '#ffffff', 4.5),
    '--mine': mine,
    '--mine-ink': ensureContrast(mix(accent, '#000000', 0.6), mine, 4.5),
    '--sold': mix(brand, '#ffffff', 0.9),
    '--sold-ink': brandDark,
    '--win': brandDark,
    '--win-ink': contrast(accent, brandDark) >= 3 ? accent : '#ffffff',
    '--me': ensureContrast(accent, '#ffffff', 3),
    '--bg': mix(brand, '#ffffff', 0.95),
    '--line': mix(brand, '#ffffff', 0.8),
    '--q-pending': mix(brandDark, '#ffffff', 0.2),
  };
}

export const themeCss = (main, accent) =>
  `:root{${Object.entries(themeVars(main, accent)).map(([k, v]) => `${k}:${v}`).join(';')}}`;

// Initials for the stand-in badge when there's no logo yet: "GHEMS PTA" -> "GHEMS",
// "Lincoln Elementary PTA" -> "LE".
export function initials(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  if (/^[A-Z0-9]{2,5}$/.test(words[0])) return words[0];
  return words.slice(0, 2).map((w) => w[0].toUpperCase()).join('');
}
