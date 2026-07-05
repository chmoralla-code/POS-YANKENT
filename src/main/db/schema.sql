-- YANKENT POS — local SQLite schema
-- All money values are stored as REAL (PHP) with 2 decimal precision.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Users & sessions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','cashier')),
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS categories (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);

-- -----------------------------------------------------------------------------
-- Products & sellable units (bulk/unit measurement support)
--   base_unit = primary stock unit (e.g. "bag","cu.m","kg","pc","roll")
--   stock     = quantity in base_unit
--   product_units holds every sellable unit with factor (relative to base_unit)
--   and its own price. The base unit is always present with factor = 1.
--   is_service = 1 marks labor/delivery services (no stock consumption).
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  sku                TEXT NOT NULL UNIQUE,
  name               TEXT NOT NULL,
  category_id        INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  base_unit          TEXT NOT NULL,
  stock              REAL NOT NULL DEFAULT 0,
  cost               REAL NOT NULL DEFAULT 0,
  price              REAL NOT NULL DEFAULT 0,        -- default unit price
  low_stock_threshold REAL NOT NULL DEFAULT 10,
  is_service         INTEGER NOT NULL DEFAULT 0,
  active             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS product_units (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  unit       TEXT NOT NULL,
  factor     REAL NOT NULL DEFAULT 1,   -- base_units consumed per 1 of this unit
  price      REAL NOT NULL DEFAULT 0,
  UNIQUE (product_id, unit)
);

-- -----------------------------------------------------------------------------
-- Customers / contractor credit accounts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL DEFAULT 'walkin' CHECK (type IN ('walkin','contractor')),
  phone        TEXT,
  credit_limit REAL NOT NULL DEFAULT 0,
  credit_used  REAL NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- -----------------------------------------------------------------------------
-- Sales (header) + sale items (lines)
--   VAT is INCLUSIVE: total is the amount charged to the customer.
--   subtotal = total / (1 + vat_rate), vat = total - subtotal.
--   txn_id is the human-readable transaction id printed on the receipt
--   (e.g. YK-000123). seq is the auto-increment used to build txn_id.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  txn_id          TEXT NOT NULL UNIQUE,
  seq             INTEGER NOT NULL,
  datetime        TEXT NOT NULL DEFAULT (datetime('now')),
  cashier_id      INTEGER REFERENCES users(id),
  cashier_name    TEXT NOT NULL,
  customer_id     INTEGER REFERENCES customers(id),
  customer_name   TEXT NOT NULL DEFAULT 'Walk-in Customer',
  project         TEXT,
  po_number       TEXT,
  subtotal        REAL NOT NULL DEFAULT 0,
  vat             REAL NOT NULL DEFAULT 0,
  discount        REAL NOT NULL DEFAULT 0,
  delivery_fee    REAL NOT NULL DEFAULT 0,
  total           REAL NOT NULL DEFAULT 0,
  payment_method  TEXT NOT NULL,
  amount_tendered REAL NOT NULL DEFAULT 0,
  change          REAL NOT NULL DEFAULT 0,
  reference       TEXT,
  status          TEXT NOT NULL DEFAULT 'completed',
  note            TEXT
);

CREATE TABLE IF NOT EXISTS sale_items (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id        INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id     INTEGER REFERENCES products(id),
  sku            TEXT NOT NULL,
  name           TEXT NOT NULL,
  unit           TEXT NOT NULL,
  qty            REAL NOT NULL,
  unit_price     REAL NOT NULL,
  amount         REAL NOT NULL,
  line_type      TEXT NOT NULL DEFAULT 'product' CHECK (line_type IN ('product','service')),
  stock_consumed REAL NOT NULL DEFAULT 0   -- base-unit units removed from stock
);

-- Audit trail for every stock change (sale / restock / adjustment)
CREATE TABLE IF NOT EXISTS stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  movement    TEXT NOT NULL CHECK (movement IN ('sale','restock','adjustment','refund')),
  qty_change  REAL NOT NULL,
  reason      TEXT,
  user_id     INTEGER REFERENCES users(id),
  datetime    TEXT NOT NULL DEFAULT (datetime('now')),
  source_location TEXT
);

-- Refunds (linked to original sale, with admin approver)
CREATE TABLE IF NOT EXISTS refunds (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  original_txn_id TEXT NOT NULL,
  original_sale_id INTEGER NOT NULL REFERENCES sales(id),
  refund_txn_id TEXT NOT NULL UNIQUE,
  datetime      TEXT NOT NULL DEFAULT (datetime('now')),
  cashier_id    INTEGER REFERENCES users(id),
  cashier_name  TEXT NOT NULL,
  admin_id      INTEGER REFERENCES users(id),
  admin_name    TEXT NOT NULL,
  customer_name TEXT,
  total         REAL NOT NULL,
  reason        TEXT,
  items_json    TEXT
);

-- Key/value store for store info, printer config, telegram config, etc.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- -----------------------------------------------------------------------------
-- Indexes for reporting performance
-- -----------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS idx_sales_datetime ON sales(datetime);
CREATE INDEX IF NOT EXISTS idx_sales_cashier ON sales(cashier_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
