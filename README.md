# YANKENT POS

An **offline-first** desktop Point-of-Sale application for construction & hardware supply stores.
Built with **Electron + SQLite (sql.js / WebAssembly)**. All sales, products, inventory, users,
receipts, and settings are stored **locally** on the cashier's laptop — **no internet required**
for normal operation.

> Brand: **YANKENT POS** · Store name printed on every receipt: `YANKENT POS`

---

## Features

- **100% offline** — local SQLite database on disk; no cloud, no login server.
- **Minimalist monochrome UI** — clean, professional, easy for cashiers.
- **Construction & supply catalog** — cement, masonry, lumber, steel, plumbing,
  electrical, paint, tools, fasteners, plus **services** (cutting, delivery, labor).
- **Bulk / unit-measurement selling** — bags, sacks, meters, kg, cubic meters,
  rolls, pieces, board feet, gallons, etc. Each product can have multiple sell
  units with their own conversion factor and price (e.g. cement sold per *bag*
  or *sack(50kg)*; sand per *cu.m*, *sack*, or *triport*).
- **Cart** — add items, edit quantity & unit, remove, void sale.
- **VAT 12% (inclusive)** — subtotal, VAT, and total computed and stored.
- **Payment methods** — Cash, Card, E-Wallet, On-Account (contractor credit).
- **Receipts** — store name `YANKENT POS`, transaction ID, cashier, date/time,
  items, qty, unit price, subtotal, VAT, total, payment method, change, thank-you.
- **Thermal printer** — ESC/POS over **Bluetooth (Web Bluetooth)**, with test
  print, auto-print after every sale, reprint, and a printable HTML fallback.
- **Telegram owner report** — admin enters BotFather token + chat ID in
  **Settings** (never hardcoded). A sales summary is sent **only when online**;
  the POS keeps working offline.
- **Reports** — today / this month / this year totals, transaction count,
  best sales day, best-selling products, sales by cashier. Printable & CSV export.
- **Backup & Import** — one-click export of the entire local database to a
  `.yankent` backup file; restore on a new laptop to recover everything.
- **Roles** — **Admin** (products, prices, stock, users, printer, Telegram,
  backup, reports) and **Cashier** (sell + print only).

---

## Tech stack

| Layer      | Technology                                   |
|------------|----------------------------------------------|
| Desktop    | Electron 31                                  |
| Database   | SQLite via **sql.js** (pure WebAssembly — no native build tools required) |
| Renderer   | Vanilla HTML/CSS/JS (no framework, no build) |
| Printer    | ESC/POS command builder + Web Bluetooth      |
| Telegram   | Node `https` (Telegram Bot API)              |
| Packaging  | `electron-builder` (Windows NSIS installer)  |

> **No C++ build tools needed.** The database runs on `sql.js` (SQLite
> compiled to WebAssembly), so `npm install` works on a clean Windows laptop
> without Visual Studio or Python. The `.sqlite` file is written to disk after
> every change.

---

## Installation (developer / new laptop)

> Requires **Node.js 20+** and **npm**. Get Node from <https://nodejs.org>.

```bash
# 1. Clone
git clone https://github.com/chmoralla-code/POS-YANKENT.git
cd POS-YANKENT

# 2. Install dependencies (pure JS/WASM — no native compilation)
npm install

# 3. Run the app
npm start
```

### Smoke test (boots the app, runs a sale through the full stack, exits)

```bash
npm run smoke
```

### First run / default logins

The database is created automatically on first launch (in `data/yankent.sqlite`
when running from source, or in the OS user-data folder when packaged) and
seeded with demo data (products, units, customers, and two user accounts):

| Role    | Username | Password    |
|---------|----------|-------------|
| Admin   | `admin`  | `admin123`  |
| Cashier | `maria`  | `cashier123`|

**Change these passwords immediately** from **Admin → Users**.

---

## Building a Windows installer

```bash
npm run dist
```

Output: `dist/YANKENT-POS-Setup-1.0.0.exe`. Install on the client laptop; the
app and database live entirely on the machine. The database is stored under
the user's app data / project `data/` folder.

---

## Usage

### Cashier (sell & print)
1. Log in as `maria` / `cashier123`.
2. Search/scan or click a category, click items to add to the cart.
3. Edit quantity & unit (for bulk items), choose payment method.
4. **Charge** → enter cash (if Cash) → receipt prints automatically.

### Admin (everything)
- **Products** — add/edit products, units & conversion factors, prices, stock.
  Only admins can change price and stock.
- **Users** — add cashiers/admins, reset passwords, deactivate.
- **Reports** — today/month/year, best-selling products, best sales day,
  sales by cashier. Print or export CSV.
- **Settings**
  - **Store** — name (default `YANKENT POS`), address, TIN, VAT rate, footer.
  - **Thermal Printer** — pair a Bluetooth ESC/POS printer, test print,
    toggle auto-print.
  - **Telegram** — enter BotFather token + chat ID, send test, send report now.
  - **Backup / Import** — export all data to one file; import to restore.

---

## Offline behavior

- The app and database are fully local. Sales work with **no internet**.
- Telegram sending checks connectivity first; if offline, the report is
  **skipped silently** (no data loss — sales remain in the local DB and can be
  reported later via **Settings → Telegram → Send report now**).

### Telegram report format

```
YANKENT POS Sales Report
Today: ₱12,500 / 24 transactions
This Month: ₱185,300
This Year: ₱1,240,900
Best Day: June 18, 2026 - ₱32,800
```

---

## Backup & recovery

- **Admin → Settings → Backup Data** → saves `yankent-backup-YYYYMMDD.yankent`
  (a single JSON file containing every table).
- On a new laptop: install YANKENT POS → log in as admin →
  **Settings → Import Data** → select the `.yankent` file. Products, sales,
  users, settings, and inventory are restored.

> Tip: also copy `data/yankent.sqlite` as a raw backup if you prefer.

---

## Project structure

```
POS-YANKENT/
├── src/
│   ├── main/                # Electron main process
│   │   ├── main.js          # window creation, IPC registration
│   │   ├── preload.js       # secure contextBridge API
│   │   ├── db/              # schema, migrations, seed
│   │   ├── ipc/             # IPC handlers (auth, products, sales, ...)
│   │   └── lib/             # money/VAT, auth/roles, receipt, escpos, telegram, backup
│   └── renderer/            # UI (monochrome, vanilla JS)
│       ├── index.html
│       ├── css/app.css
│       └── js/              # app, pos, products, users, reports, settings, printer
├── tests/                   # node:test — VAT, totals, backup/import, roles
├── data/                    # local SQLite DB (gitignored)
└── package.json
```

---

## Database schema

See [`src/main/db/schema.sql`](src/main/db/schema.sql) for the full schema:
`users`, `categories`, `products`, `product_units`, `customers`, `sales`,
`sale_items`, `stock_movements`, `settings`. The engine is `sql.js`
(WebAssembly SQLite) wrapped by a small better-sqlite3-compatible shim
([`src/main/db/shim.js`](src/main/db/shim.js)) so the codebase uses a
familiar synchronous API.

---

## Tests

```bash
npm test
```

Covers: transaction totals & VAT calculation, backup/import round-trip, and
role-based permission enforcement.

---

## Security notes

- Telegram token & chat ID are stored in the **local** `settings` table only —
  they are **never hardcoded** in source and never leave the machine except to
  the Telegram Bot API when the admin explicitly sends a report.
- Passwords are hashed with `crypto.scrypt` (never stored in plain text).
- The preload bridge exposes a minimal, validated API; no direct DB access
  from the renderer.

---

## License

MIT © YANKENT
