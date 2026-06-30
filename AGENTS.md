# AGENTS.md — YANKENT POS

Offline construction & supply POS. Electron + sql.js (WebAssembly SQLite), vanilla JS renderer.

## Commands
- `npm start` — launch the Electron app (dev).
- `npm test` — run unit tests (money/VAT, backup/import, roles). Pure Node + sql.js.
- `npm run lint` — `node --check` syntax validation of all main/lib/ipc/test files.
- `npm run smoke` — boot the app, run a full sale through the IPC stack, exit.
- `npm run dist` — build the Windows NSIS installer into `dist/`.

## Layout
- `src/main/` — Electron main process: `main.js`, `preload.js`, `db/` (schema, seed, sql.js shim), `ipc/` (handlers), `lib/` (money, auth, receipt, escpos, telegram), `backup.js`.
- `src/renderer/` — UI: `index.html`, `css/app.css`, `js/` (app, pos, products, users, reports, settings, printer, ui).
- `tests/` — `node:test`.

## Conventions
- DB engine is sql.js via a better-sqlite3-compatible shim (`src/main/db/shim.js`). Use `db.prepare(sql).get()/all()/run()` and `db.transaction(fn)()`. The shim flushes to disk after writes.
- Renderer talks to main only through `window.pos.*` (preload contextBridge). No direct DB access.
- Monochrome theme; keep new UI in `css/app.css` style.
- VAT is inclusive (12%): `total` is what the customer pays; `subtotal = total/1.12`, `vat = total - subtotal` (see `lib/money.js`).
- Telegram token/chat ID and printer UUIDs live in the `settings` table — never hardcode.
