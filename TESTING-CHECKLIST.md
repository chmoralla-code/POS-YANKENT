# YANKENT POS — Pre-Release Testing Checklist

Run through every item before delivering to the client. Mark each with [x] when verified.

**Login credentials:** admin / admin123 — cashier / cashier123

---

## 1. Startup & App Launch

- [ ] App opens without crashing (no white screen, no silent quit)
- [ ] Loading spinner shows with progress bar
- [ ] Loading screen disappears within ~5 seconds
- [ ] Login screen is visible after loading
- [ ] App version shows on login screen
- [ ] Network status pill shows "Online" or "Offline-ready"
- [ ] Login background video plays (muted, looped)
- [ ] Theme toggle (sun/moon icon) works on login screen
- [ ] If app is already running, second launch focuses the existing window (not a new one)
- [ ] **Crash recovery:** if the `.sqlite` file is corrupted, the app backs it up and creates a fresh DB instead of hanging on the loading screen
- [ ] **Timeout:** if the backend doesn't respond within 15s, the loading screen still progresses to login (not stuck forever)

## 2. Login & Authentication

- [ ] Admin login (admin / admin123) succeeds
- [ ] Cashier login (cashier / cashier123) succeeds
- [ ] Wrong password shows error message and shakes the login panel
- [ ] Unknown username shows same error (no user enumeration)
- [ ] Password toggle (eye icon) shows/hides password
- [ ] Logout returns to login screen
- [ ] Login button resets to "Sign In" after logout
- [ ] Forgot Password flow: enter username → Telegram request sent → admin approves → reset password → login with new password
- [ ] Forgot password: expired request (10 min) shows "expired"
- [ ] Forgot password: denied request shows "denied"

## 3. Role-Based Access

- [ ] Cashier sees only "Point of Sale" in sidebar
- [ ] Admin sees all nav items: POS, Products, Users, Reports, Settings
- [ ] Cashier cannot access Products (toast: "Administrator access required")
- [ ] Cashier cannot access Users, Reports, or Settings
- [ ] "Send Report" button in topbar is visible to both roles

## 4. Point of Sale (POS)

### Catalog & Navigation
- [ ] Products tab shows physical products with price and stock
- [ ] Services tab shows services with price
- [ ] Category chips filter products correctly
- [ ] Search by name or SKU works
- [ ] Out-of-stock products show "OUT OF STOCK" label
- [ ] Low-stock products show "low" badge
- [ ] Analytics bar at top shows Today / Yesterday / Month / Year / Best Day / Avg Tx / Items Sold / Payments

### Cart Operations
- [ ] Click a product card to add it to cart
- [ ] Click a service card → prompts for quantity → adds to cart
- [ ] Cart shows item name, unit price, quantity, line total
- [ ] Quantity +/- buttons work
- [ ] Direct quantity input works
- [ ] Unit dropdown works for multi-unit products (e.g. cement: bag / sack)
- [ ] Stock validation prevents overselling (toast: "Not enough stock")
- [ ] Remove item (x) works
- [ ] Totals update: Materials, Services, VAT 12%, Total
- [ ] Discount button toggles discount (if admin has set discount %)
- [ ] Void button clears the entire cart (with confirmation)

### Customer & Payment
- [ ] Walk-in Customer is default
- [ ] Selecting a contractor shows credit info (limit, used, available)
- [ ] Payment methods: Cash, Card, E-Wallet, On-Account
- [ ] On-Account requires a contractor customer (error if walk-in)
- [ ] Cash payment: shows change calculation in checkout modal
- [ ] Card/E-Wallet: shows reference number field

### Checkout & Sale Completion
- [ ] Charge button opens checkout modal with correct total
- [ ] Confirm & Print completes the sale
- [ ] Stock is decremented correctly after sale
- [ ] POS cache refreshes (stock values update in catalog)
- [ ] Cart clears after sale
- [ ] Customer selection resets to Walk-in
- [ ] Discount resets to off
- [ ] Receipt modal shows with correct items, totals, change
- [ ] Analytics bar refreshes after sale
- [ ] **Sale completion is NOT blocked by auto-print** (cashier can immediately start a new sale even if print is still running)

### Receipt & Printing (POS)
- [ ] Receipt modal: Close button works
- [ ] Receipt modal: Reprint (Bluetooth) works if printer connected
- [ ] Receipt modal: Print (system) opens Windows print dialog
- [ ] Auto-print fires after sale (if auto-print is enabled in settings)
- [ ] **Second consecutive sale + print works** (print is not broken after first print)

### Refunds
- [ ] Refund button opens transaction ID lookup
- [ ] Valid transaction ID shows sale details
- [ ] Admin PIN required to process refund
- [ ] Invalid admin PIN is rejected
- [ ] Refund restocks items
- [ ] Refund marks original sale as "refunded"
- [ ] Cannot refund the same sale twice
- [ ] Refund receipt shows with print option

## 5. Products & Inventory (Admin)

### Product List
- [ ] All active products display in the grid
- [ ] Products show name, price, stock, category color bar
- [ ] Services show "svc" badge and "Service" instead of stock
- [ ] Low-stock products show "low" badge
- [ ] Category chips filter correctly with product counts
- [ ] Search filters by name
- [ ] **Products do NOT disappear after completing a sale and returning to this page** (stale search filter bug fix)

### Product Management
- [ ] Add Product: creates product with name, category, base unit, stock, cost, price, low-stock threshold
- [ ] Add Product: can mark as service (no stock)
- [ ] Add Product: can add multiple sellable units with conversion factors
- [ ] Add Product: can create a new category on-the-fly from the dropdown
- [ ] Edit Product: all fields are editable except stock (readonly)
- [ ] **Edit Product does NOT soft-delete the product** (active status preserved)
- [ ] Edit Product: can modify sellable units
- [ ] Stock button: opens stock adjustment modal
- [ ] Stock adjustment: sets new stock, logs delta with reason
- [ ] Stock adjustment: rejects services
- [ ] Delete (Del): soft-deletes product (active=0), disappears from list
- [ ] Delete All Products: double confirmation, soft-deletes all, preserves categories
- [ ] Import Catalog: creates 135 products with categories, skips duplicates

### Category Management
- [ ] Manage Categories modal opens
- [ ] Add new category works
- [ ] Rename category works
- [ ] Delete category works (products get category_id = NULL)
- [ ] Category counts update correctly

## 6. Users & Roles (Admin)

- [ ] User list shows all users with username, name, role, status
- [ ] Add User: creates user with username, password, full name, role
- [ ] Add User: password minimum 4 characters enforced
- [ ] Add User: duplicate username rejected
- [ ] Edit User: full name and role are editable (username is readonly)
- [ ] Edit User: can activate/deactivate user
- [ ] Edit User: optional password change (leave blank to keep current)
- [ ] Change Password modal: validates min length 4
- [ ] Change Password modal: validates passwords match
- [ ] Edited user can log in with new password
- [ ] Deactivated user cannot log in

## 7. Reports (Admin)

### Summary & Analytics
- [ ] Summary stats show: Today, Yesterday, This Month, This Year, Best Day
- [ ] Refund stat card shows today's refund total and count (red border)
- [ ] Analytics panel: Avg Transaction, Items Sold, Payment breakdown
- [ ] Top Products table shows today's best sellers
- [ ] Top Cashier table shows today's top cashier
- [ ] Best-selling Products table shows all-time best sellers
- [ ] Sales by Cashier table shows per-cashier totals
- [ ] Sales by Day table shows daily totals
- [ ] Recent Sales table shows recent transactions
- [ ] Refund Log table shows all refunds

### Date Filtering
- [ ] From/To date filter applies to all tables
- [ ] Apply button reloads data with filter
- [ ] Empty dates show all data

### Export & Print
- [ ] CSV export: Best Selling works (save dialog, file opens correctly)
- [ ] CSV export: By Cashier works
- [ ] CSV export: Sales by Day works
- [ ] CSV export: All Sales works
- [ ] Print button opens system print dialog with formatted report
- [ ] Send to Telegram button sends report + backup

### Reset Sales
- [ ] Reset All Sales: first confirmation dialog appears
- [ ] Reset All Sales: second (final) confirmation required
- [ ] Reset All Sales: wipes sales, sale_items, refunds, stock_movements
- [ ] Reset All Sales: preserves users, products, categories, customers, settings
- [ ] Reset All Sales: resets product stock to 0

## 8. Settings (Admin)

### Store Information
- [ ] All store fields are editable (name, address, TIN, phone)
- [ ] VAT rate is editable
- [ ] Currency symbol is editable (updates all money displays)
- [ ] Receipt width is editable (32 or 48 chars)
- [ ] Discount percent is editable
- [ ] Receipt footer is editable (multi-line)
- [ ] Save button persists all settings

### Thermal Printer
- [ ] Bluetooth availability badge shows correctly
- [ ] Pair Bluetooth Printer button works (opens Web Bluetooth dialog)
- [ ] Test Print works (sends ESC/POS bytes to paired printer)
- [ ] System Print Test works (opens Windows print dialog)
- [ ] Install Printer Driver button launches the installer (UAC prompt)
- [ ] Printer type dropdown: bluetooth / system / none
- [ ] Auto-print checkbox saves correctly
- [ ] Service/Characteristic UUID fields are editable
- [ ] Save printer settings button persists

### Telegram
- [ ] Network status pill shows online/offline
- [ ] Bot token and Chat ID fields are editable
- [ ] Save button persists Telegram settings
- [ ] Send test message works (if online and configured)
- [ ] Send report now works (sends message + backup file)
- [ ] Telegram preview shows formatted summary

### Backup & Import
- [ ] Backup Data: save dialog opens, .yankent file created
- [ ] Backup result shows table counts
- [ ] Import Data: confirmation dialog appears
- [ ] Import Data: file picker opens
- [ ] Import Data: restores all tables correctly
- [ ] Import Data: invalid file is rejected with error
- [ ] Import Data: settings refresh after import

### Updates
- [ ] Current version displays
- [ ] Check for Updates button works
- [ ] "Up to date" message shows when no update available
- [ ] "What's New" modal shows when update available
- [ ] Download progress bar works
- [ ] Restart & Install button works

## 9. Printing — Comprehensive

- [ ] **Bluetooth print after first sale works**
- [ ] **Bluetooth print after second consecutive sale works**
- [ ] **System print after first sale works**
- [ ] **System print after second consecutive sale works**
- [ ] Reprint from receipt modal works
- [ ] Reprint from Reports > Recent Sales works
- [ ] Print from Reports > Print button works
- [ ] Refund receipt print works
- [ ] Receipt contains: store name, address, TIN, txn ID, date, cashier, customer, items, totals, VAT, change, footer
- [ ] Receipt handles special characters correctly
- [ ] Print does not hang the app (60s timeout safety net)
- [ ] Concurrent print attempts are blocked ("A print job is already in progress")
- [ ] Print errors show a toast notification
- [ ] **Receipt lines do NOT wrap mid-number** (prices like `PHP 2,055.20` print on one line, not split as `PHP 2,055` + `.20`) — peso sign + ellipsis expansion fix
- [ ] **Long item names truncate cleanly** with `...` (no blank boxes, no mid-word wrap)
- [ ] **Long store address wraps** across lines instead of overflowing the paper
- [ ] **Receipt footer wraps** if a line is longer than the paper width
- [ ] **48-char width** works without wrapping when `receipt_width` is set to 48 in Settings

## 10. Edge Cases & Error Handling

- [ ] Empty cart: Charge button shows "Cart is empty"
- [ ] Insufficient cash: sale rejected with error
- [ ] Insufficient stock: sale rejected with error
- [ ] On-Account payment exceeding credit limit: rejected with error
- [ ] **Invalid/empty payment method: sale rejected with "Invalid payment method"** (regression — used to bypass cash + credit checks)
- [ ] Network disconnection: app still works (offline-ready)
- [ ] App crash during write: database recovers on next launch
- [ ] Large cart (20+ items): performance is acceptable
- [ ] Rapid consecutive sales: no state corruption
- [ ] Navigating between views during a sale: no data loss
- [ ] Closing receipt modal during auto-print: no crash
- [ ] Database corruption: app backs up and creates fresh DB

## 11. Recently Fixed Bugs — Verify

- [ ] **Auto-print doesn't block sale completion** (fire-and-forget)
- [ ] **Second consecutive print works** (printHtml timeout + cleanup)
- [ ] **Print errors are visible** (toast for system print failures)
- [ ] **App doesn't hang on startup** (DB crash recovery + 15s timeout)
- [ ] **Null-safe receipt encoding** (no crash if sale lookup fails)
- [ ] **Receipt doesn't wrap mid-number** (peso sign + ellipsis expansion fixed; lines fit the configured paper width)
- [ ] **Product card action buttons are color-coded** (Edit = blue, Stock = violet, Del = red)
- [ ] **Invalid payment method is rejected** (e.g. `bitcoin` or empty → "Invalid payment method", cannot bypass cash/credit checks)
- [ ] **Refunds list limit is capped** (cannot request unbounded rows and freeze the UI)
- [ ] **Role gate is strict** (cashier cannot reach admin endpoints; admin always passes)

## 12. Build & Package

- [ ] `npm run lint` passes with no errors
- [ ] `npm test` passes (63 tests, 0 failures)
- [ ] `npm run dist` produces Windows NSIS installer
- [ ] Installer runs without errors on a clean Windows machine
- [ ] Packaged app opens and functions correctly
- [ ] Packaged app's database is at `%APPDATA%\YANKENT POS\yankent.sqlite`
- [ ] Desktop shortcut is created
- [ ] Auto-update works from a GitHub Release
- [ ] Uninstaller removes the app cleanly

---

**Sign-off**

| Tester | Date | Result |
|---|---|---|
| | | Pass / Fail |
| | | Pass / Fail |
