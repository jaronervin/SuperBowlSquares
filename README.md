# Squares

Football squares fundraiser. Helpers sign people up in person on tablets; buyers get a link to watch their squares, the drawn numbers, live scores and winners.

- **`/`** — public board. Shows first name + last initial on each square, numbers, scores, winners. Nothing about money. A buyer's personal link (`/?me=…`) outlines their squares.
- **`/helper`** — sign-up table (helper passcode). Tapping a square holds it for 3 minutes (adjustable) so no other helper can take it. Squares are only saved when the helper confirms payment.
- **`/admin`** — admin passcode. Money totals, open/close sales, add boards, draw numbers, scores, winners, refunds, sales log, settings.

Runs on Cloudflare Workers with a D1 (SQLite) database, on the free tier.

## How the game runs

1. **Selling.** Helpers pick squares on the open board. When a board fills, the next one opens automatically. Admin can also add boards by hand.
2. **Closing.** Admin taps **Close sales**. Any board that isn't full gets **Didn't fill: refund**, which lists who to pay back and how much.
3. **Drawing.** For each full board, admin taps **Draw numbers**. Digits 0–9 are shuffled with a secure random generator, separately for the top and side, and shown publicly with a timestamp. It can't be redone.
4. **Game.** Scores come from ESPN automatically during the game (set both team abbreviations and the game date in Settings). Any quarter can be typed in by hand if ESPN is wrong or unavailable. Q4 is the score at the end of regulation; overtime never counts.
5. **Prizes.** Winners (with contact info) appear on the admin page as each quarter ends. Tick **Basket given** when delivered.

## One-time setup (Cloudflare dashboard, no terminal needed)

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**. Connect GitHub, pick this repo, and keep the project name **`squares`** (it must match `name` in `wrangler.jsonc`). Leave the build settings as they are and deploy. The first deploy creates the `squares` database by itself; the app creates its tables the first time it runs.
2. Open the new worker → **Settings → Variables and Secrets** → add two **Secrets**:
   - `HELPER_PIN`: the passcode helpers type on the tablets
   - `ADMIN_PIN`: your passcode for the admin page

   Use at least 6 characters. After 10 wrong tries from one network, sign-in pauses for 15 minutes. Changing either passcode signs everyone out.
3. Open the address shown on the worker's page (e.g. `https://squares.<your-subdomain>.workers.dev/admin`), sign in with `ADMIN_PIN`, and fill in Settings.

Every push to `main` redeploys automatically. To use your own domain, add it under the worker's **Settings → Domains & Routes**.

## Venmo QR code

In the Venmo app, open your QR code and save it as an image. Add it to this repo as `public/venmo-qr.png` (or send it to Claude to add); the site redeploys on its own. Until then the checkout screen shows a placeholder. Also set your Venmo username in admin Settings.

## Running locally

```bash
npm install
printf 'HELPER_PIN=helper123\nADMIN_PIN=admin123\n' > .dev.vars
npm run dev
```

Then open http://localhost:8787/helper.

## Notes

- Screens poll for changes (helpers every 2 seconds, public every 15) and only download the board when something changed, which keeps the database well inside the free tier.
- **Void** on a sale (admin) puts its squares back on sale. It's for mistakes made before numbers are drawn; refund the buyer yourself.
- ESPN's scoreboard feed is public but unofficial. If it changes or goes down, type scores in by hand on the admin page.

## Tests

- `npm test` checks the ESPN score parsing, including an overtime game (no server needed).
- `tests/api-test.mjs` runs the whole flow against a fresh local server: two helpers fighting over one square, sales, auto-new board, the draw, winners, refunds.
