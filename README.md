# Squares

Football squares fundraiser. Helpers sign people up in person on tablets; buyers get a link to watch their squares, the drawn numbers, live scores and winners.

- **`/`** — public board. Shows first name + last initial on each square, numbers, scores, winners. Nothing about money. A buyer's personal link (`/?me=…`) outlines their squares.
- **`/helper`** — sign-up table (helper passcode). Tapping a square holds it for 3 minutes (adjustable) so no other helper can take it. Squares are only saved when the helper confirms payment.
- **`/admin`** — admin passcode. Money totals, open/close sales, add boards, draw numbers, scores, winners, refunds, sales log, settings.

Runs on Cloudflare Workers with a D1 (SQLite) database, on the free tier.

## Online orders

Turn on **Online sales** on the admin page. The public page then shows a **Buy squares online** button:

1. The buyer picks squares at `/buy` (held for them with the same timer helpers use), enters their name and phone or email, and taps **Reserve and pay**.
2. Their order page (their personal link) has a **Pay with Venmo** button that opens Venmo with the amount and a note like `Squares B1-12 B1-13 Order K7QP`. They have 30 minutes (adjustable) to pay and tap **I've sent the payment**, or the squares go back on sale.
3. The order shows under **Online orders** on the admin page. Find the payment in Venmo by its order code, then **Confirm** (squares become theirs) or **Reject** (squares go back on sale). Orders not confirmed within 24 hours (adjustable) go back on sale on their own.

Squares waiting on an online order show striped on every grid and can't be picked. Numbers can't be drawn on a board until every square on it is confirmed. Only confirmed orders count toward money totals. One person (by network) can have at most 5 orders waiting at once.

Email notices (to the organizer when someone pays, and a "you're confirmed" email to the buyer) need a custom domain and aren't set up yet.

## corkandpin.com front page

The `home/` folder is a separate, static site: the corkandpin.com front page (`index.html`), a privacy page and a 404 page. No code or database. It deploys as its own Cloudflare worker, `corkandpin-home`, with **Root directory** set to `home` in its build settings. Preview locally with `cd home && npx wrangler dev`.

## How the game runs

1. **Selling.** Helpers pick squares on the open board. When a board fills, the next one opens automatically. Admin can also add boards by hand.
2. **Closing.** Admin taps **Close sales**. Any board that isn't full gets **Didn't fill: refund**, which lists who to pay back and how much.
3. **Drawing.** For each full board, admin taps **Draw numbers**. Digits 0–9 are shuffled with a secure random generator, separately for the top and side, and shown publicly with a timestamp. It can't be redone.
4. **Game.** Scores come from ESPN automatically during the game. Teams: on game day, if none are entered and ESPN lists only one NFL game that day (always true for the Super Bowl), the app picks that game and fills in the team names itself. To set them earlier (once the matchup is known), tap **Find the game on ESPN** on the admin page and choose which team goes across the top. Any quarter can be typed in by hand if ESPN is wrong or unavailable. Q4 is the score at the end of regulation; overtime never counts.
5. **Prizes.** Winners (with contact info) appear on the admin page as each quarter ends. Tick **Basket given** when delivered.

## One-time setup (Cloudflare dashboard, no terminal needed)

1. In the Cloudflare dashboard, go to **Workers & Pages → Create → Import a repository**. Connect GitHub, pick this repo, and keep the project name **`squares`** (it must match `name` in `wrangler.jsonc`). Leave the build settings as they are and deploy. The first deploy creates the `squares` database by itself; the app creates its tables the first time it runs.
2. Open the new worker → **Settings → Variables and Secrets** → add one **Secret**, `SETUP_CODE`, set to any one-time code (e.g. a few random words). Give that code to the group's admin.
3. The admin opens `/admin`, enters the setup code, and picks their own admin and helper passcodes. The setup wizard then walks them through their name, logo and colors, price, game date, Venmo username and helper passcode. The setup code only works once.

   (The first site, GHEMS, was set up with `ADMIN_PIN` / `HELPER_PIN` secrets instead. Those keep working until the passcodes are changed on the admin page, after which the admin page's passcodes take over.)
4. Open the address shown on the worker's page (e.g. `https://squares.<your-subdomain>.workers.dev/admin`), sign in with `ADMIN_PIN`, and fill in Settings.

Every push to `main` redeploys automatically. To use your own domain, add it under the worker's **Settings → Domains & Routes**.

## Tablets

On each tablet, open `/helper` and use **Share → Add to Home Screen**. The icon opens the sign-up table full-screen, without the browser's tabs and address bar, which gives the grid more room.

## Venmo QR code

Set your Venmo username on the admin page (Settings). The payment screen then shows a QR code made for that order: scanning it with a phone camera opens Venmo to pay you, with the amount and the squares (e.g. "Squares B1-12 B1-13") already filled in. Test it once with your own phone before the event.

Without a username, the payment screen shows `public/venmo-qr.png` if you add one, or a placeholder.

QR codes are drawn by [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT license), saved in `public/vendor/`.

## Running locally

```bash
npm install
printf 'HELPER_PIN=helper123\nADMIN_PIN=admin123\n' > .dev.vars
npm run dev
```

Then open http://localhost:8787/helper.

## Notes

- After changing `app.css`, `common.js` or a page script, bump the `?v=` number on every link and `import` of it (in `public/*.html` and `public/*.js`), so browsers don't keep an old copy.

- Screens poll for changes (helpers every 2 seconds, public every 15) and only download the board when something changed, which keeps the database well inside the free tier.
- New boards take the lowest unused number, so a deleted board's number gets reused.
- **Passcodes** are changed on the admin page (Passcodes section). Changing the helper passcode signs out every helper tablet; changing the admin passcode signs out admins on other devices. They're stored hashed in the database, never in plain text.
- **Branding** (admin page → Branding, or the setup wizard): organization name, public contact, an "about" blurb, a logo (cropped and shrunk on the phone, optional white-background removal) and two colors, with suggestions taken from the logo. Colors are adjusted automatically where needed so text stays readable. Without a logo, the group's initials show in their colors. Pages are served with the branding already in them, so link previews show the group's name and logo.
- **Next year:** on the admin page, tap **Download sales** to keep a record, then **Start a new year** (type `START OVER`). That erases boards, sales, refunds, prizes and scores, clears the teams and game date, and opens Board 1. Title, price, hold time, Venmo username, prize line and passcodes stay.
- **Void** on a sale (admin) puts its squares back on sale. It's for mistakes made before numbers are drawn; refund the buyer yourself.
- ESPN's scoreboard feed is public but unofficial. If it changes or goes down, type scores in by hand on the admin page.

## Tests

- `npm test` checks the ESPN score parsing, including an overtime game (no server needed).
- `tests/api-test.mjs` runs the whole flow against a fresh local server: two helpers fighting over one square, sales, auto-new board, the draw, winners, refunds.
- `tests/online-test.mjs` covers online orders: reserve, pay, confirm, reject, cancel, and a real 1-minute expiry (takes about 80 seconds). Same setup as above.
- `tests/delete-board-test.mjs` checks deleting a board (confirmation, sales split across boards, totals). Same setup as above.
