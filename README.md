# Forex Risk Calculator

Mobile-first, offline-capable PWA that tells you the lot size to use so that the total loss at your
stop — **including commission and an optional slippage buffer** — never exceeds your chosen risk.
Supports GBP and USD accounts with correct currency conversion.

No login, no build step, no dependencies. Everything (accounts, settings, last exchange rates) is stored
in your browser's `localStorage`.

## Use it
- Open the public link, then on iPhone: **Share → Add to Home Screen**. It works offline after the first visit.
- Workflow: pick account → pick pair → type stop loss → read **USE x.xx LOTS**.

## How the lot size is calculated
1. Pip value (quote ccy) = contract size × pip size (index: editable value per point, default $1)
2. To USD: JPY ÷ USDJPY, CHF ÷ USDCHF, CAD ÷ USDCAD
3. GBP account: ÷ GBPUSD
4. Risk per lot = (stop + slippage) × pip value + commission per lot (round turn)
5. Lots = risk ÷ risk per lot, **rounded down** to the lot step, then re-verified so loss ≤ risk.

Live rates come from api.frankfurter.app (fallback: open.er-api.com), are cached for offline use and can
be overridden manually.

## Files
- `calc.js` — pure calculation core (used by the app and the tests)
- `app.js`, `index.html`, `styles.css` — UI
- `sw.js`, `manifest.webmanifest`, `icons/` — PWA
- `tests/calc.test.js` — automated tests (`npm test`, Node 18+)
- `scripts/make-icons.js` — regenerates the PNG icons

## Run locally
```
npm test
npm start   # http://localhost:8080
```

## Publish (public link)
The workflow in `.github/workflows/pages.yml` runs the tests and deploys to GitHub Pages on every push to
`main`. One-time setup: repo **Settings → Pages → Source: GitHub Actions**. The link will be
`https://<user>.github.io/<repo>/`. (The repo must be public for Pages on a free plan.)
Any static host (Netlify, Cloudflare Pages, Vercel) also works — just upload the folder.
