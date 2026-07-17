# Utang / Loan Customer Management Design

## Overview

The Utang feature extends YANKENT POS's existing `customers` and On-Account sale flow with a durable per-loan ledger, profile UI, payment history, and a main-process Telegram reminder scheduler. It remains offline-first: all customer, sale, loan, and payment operations use the local sql.js database; Telegram delivery is opportunistic and never blocks core POS work.

The implementation follows existing boundaries:

- Renderer code uses only explicit `window.pos.*` methods.
- IPC handlers validate and authorize every mutation in the Electron main process.
- Multi-record accounting changes run inside `db.transaction(fn)()`.
- UI is vanilla JavaScript and monochrome CSS.
- Existing inclusive-VAT sale calculations remain authoritative.
- Existing `customers.credit_used` remains a compatibility/credit-check cache, reconciled to open Loan balances after every Loan mutation and import.

## Architecture

```text
Renderer
  index.html / app.css
  pos.js ---------------------- customer selection + due date at checkout
  utang.js -------------------- shared cashier/admin Utang page
          |
          | window.pos.loans.* / window.pos.customers.*
          v
Preload
  preload.js ------------------ explicit contextBridge methods
          |
          v
Main IPC
  ipc/loans.js ---------------- profiles, lists, details, payments, admin actions
  ipc/sales.js ---------------- due-date validation + Loan creation/refund/reset sync
          |
          v
Domain / persistence
  db/schema.sql + db/index.js -- additive migration + legacy balance bootstrap
  lib/loans.js ---------------- validation, status, balance reconciliation, helpers
  backup.js ------------------- schema-v2 export/import
          |
          +--------------------> lib/loan-reminders.js
                                  eligibility, message construction, idempotency
                                           |
                                           v
                                  lib/telegram.js sendMessage()
```

## Data Model

### Extended `customers`

The existing `type` column remains `walkin|contractor`; every profile created through Utang is a `contractor`. Additive columns avoid rebuilding existing installations:

| Column | Type/default | Purpose |
|---|---|---|
| `entity_kind` | TEXT `'individual'` | `individual` or `company` |
| `contact_person` | TEXT | Required for company profiles |
| `email` | TEXT | Optional contact email |
| `address` | TEXT | Optional address |
| `notes` | TEXT | Internal account notes |
| `active` | INTEGER `1` | Prevents new credit while retaining history |
| `updated_at` | TEXT | Last profile mutation |

`name`, `phone`, `credit_limit`, and `credit_used` remain in place. Main-process validation enforces enums because older SQLite tables cannot gain equivalent CHECK constraints through a simple additive migration.

### Extended `sales`

Add `due_date TEXT`. It is null for non-account sales and required in `YYYY-MM-DD` form for new On-Account sales. Storing it on the pending sale preserves the selected date between `pos:sales:create` and `pos:sales:commit`, and allows receipts/reprints to retain historical terms.

### New `loans`

| Column | Purpose |
|---|---|
| `id` | Autoincrement primary key |
| `loan_number` | Unique display ID (`UT-000001`) |
| `customer_id` | Owning profile |
| `sale_id` | Unique linked sale; null for Legacy Balance |
| `source` | `sale`, `legacy`, or `adjustment` |
| `principal` | Original amount established by this Loan |
| `balance` | Current unpaid amount, rounded to two decimals |
| `due_date` | Local `YYYY-MM-DD`, nullable only for migrated legacy data |
| `state` | Durable lifecycle: `open`, `paid`, or `cancelled` |
| `note` | Internal note/migration explanation |
| `created_by`, `created_by_name` | Audit actor; nullable for migration |
| `created_at`, `updated_at` | Audit timestamps |
| `paid_at`, `cancelled_at` | Lifecycle timestamps |

“Due Soon”, “Due Today”, “Overdue”, and “Due Date Required” are derived presentation statuses, not stored states. This prevents status drift as the calendar advances.

### New `loan_payments`

Each received payment is immutable. Fields include Loan/customer IDs, amount, payment method (`cash|card|ewallet|bank|other`), reference, note, receiving user/name, `paid_at`, and reversal metadata (`reversed_at`, `reversed_by`, `reversed_by_name`, `reversal_reason`). A reversal marks the row and restores the balance; it never deletes history.

### New `loan_events`

Append-only audit rows capture non-payment changes:

- `created`
- `legacy_created`
- `due_date_changed`
- `balance_adjusted`
- `payment_reversed`
- `sale_refunded`
- `cancelled`
- `reactivated`

Each row stores Loan/customer IDs, actor ID/name, signed amount delta when applicable, old/new due dates when applicable, reason, and timestamp. This provides due-date and administrative adjustment history without silently rewriting accounting state.

### New `loan_reminders`

A unique `(loan_id, reminder_date)` row reserves and records one Reminder Day. It stores state (`pending|sent|failed`), attempt count, last error, Telegram message ID when returned, `created_at`, and `sent_at`. The scheduler serializes runs in memory and uses the unique key to prevent overlapping checks from sending the same Loan twice.

### Indexes

Add indexes for:

- `loans(customer_id, state)`
- `loans(due_date, state)`
- `loans(sale_id)`
- `loan_payments(loan_id, paid_at)`
- `loan_events(loan_id, created_at)`
- `loan_reminders(reminder_date, state)`
- active customer name lookup

## Migration Strategy

`schema.sql` creates the complete schema on fresh installs. `db/index.js::migrate` remains idempotent and performs additive `ALTER TABLE` operations after checking `PRAGMA table_info`.

Migration order:

1. Add new customer profile columns when absent.
2. Add `sales.due_date` when absent.
3. Ensure new Loan tables/indexes exist through `schema.sql`.
4. For each customer with `credit_used > 0` and no Loan rows, create one `source='legacy'` Loan with matching principal/balance, null Due Date, and a migration event.
5. Do not synthesize historical due dates or duplicate historical sales as open Loans.
6. Reconcile each customer's cached `credit_used` to the sum of open positive Loan balances.

The migration is safe on every startup because the customer existence check prevents duplicate Legacy Balances.

## Domain Helpers

Create `src/main/lib/loans.js` for shared behavior used by sales IPC, Loan IPC, backup restore, and reminders:

- strict integer/text/date/money validators
- local-date formatting and date-only day arithmetic
- derived status and day-count calculation
- `createSaleLoan(db, sale, session)`
- `reconcileCustomerCredit(db, customerId)`
- `reconcileAllCustomerCredit(db)`
- profile normalization
- loan detail hydration (sale items, payments, events)
- loan number finalization from inserted ID

Date-only arithmetic will parse `YYYY-MM-DD` components in UTC for day differences, avoiding daylight-saving or midnight timestamp drift while still choosing “today” from the machine's local calendar.

## IPC and Authorization

Create `src/main/ipc/loans.js` and register it from `ipc/index.js`.

### Authenticated cashier/admin channels

- `pos:loans:summary(filters)`
- `pos:loans:listCustomers(filters)`
- `pos:loans:getCustomer(customerId)`
- `pos:loans:get(loanId)`
- `pos:loans:createCustomer(profile)`
- `pos:loans:recordPayment(loanId, payment)`
- `pos:loans:reminderStatus()` (sanitized; no Telegram credentials)

### Administrator-only channels

- `pos:loans:updateCustomer(customerId, profile)`
- `pos:loans:setCustomerActive(customerId, active)`
- `pos:loans:setDueDate(loanId, dueDate, reason)`
- `pos:loans:adjustBalance(loanId, delta, reason)`
- `pos:loans:reversePayment(paymentId, reason)`
- `pos:loans:runReminders()` (manual retry/status action if exposed)

Every handler validates IDs, text lengths, money, methods, and dates itself. Renderer visibility is not treated as authorization.

`preload.js` exposes the same explicit methods under `window.pos.loans`; it never exposes generic SQL, settings credentials, or arbitrary IPC invocation.

## Sale Integration

### Renderer flow

`pos.js` gains a customer area in **Current Sale**:

- searchable select of active contractor profiles
- selected profile's outstanding, credit limit, and available credit
- quick **Add Customer/Company** action using the same profile form as Utang
- Due Date input shown and required only for On-Account

The existing On-Account button remains disabled/rejected until a valid active customer is selected. Checkout payload includes `dueDate` only for On-Account.

### Main-process flow

`pos:sales:create`:

1. Validate payment method as today.
2. For On-Account, validate customer eligibility, Due Date format/range, and available credit.
3. Save Due Date on the pending sale.
4. Do not create a Loan yet.

`pos:sales:commit` transaction:

1. Revalidate stock, customer status, and available credit.
2. Deduct stock and write movements.
3. Mark sale complete.
4. Create one linked Loan using sale total and Due Date.
5. Reconcile customer credit.

A unique `loans.sale_id` constraint prevents duplicate Loan creation if commit is retried.

### Refund/reset behavior

A full On-Account refund changes the linked open/paid Loan to `cancelled`, sets its remaining balance to zero, records an event, and reconciles customer credit. Existing Payment history remains visible. The destructive “reset all sales” operation removes Loan children before Loans/sales and resets customer credit in the same transaction.

## Payment and Adjustment Transactions

### Record Payment

Within one transaction:

1. Load and validate an open Loan.
2. Reject amount `<= 0` or greater than balance.
3. Insert payment with authenticated receiver snapshot.
4. Reduce Loan balance with two-decimal rounding.
5. Mark Paid and set `paid_at` if balance becomes zero.
6. Reconcile customer credit.

### Reverse Payment (admin)

Within one transaction:

1. Load a non-reversed Payment and require a reason.
2. Mark its reversal metadata.
3. Increase Loan balance by its amount.
4. Reopen a previously Paid Loan and clear `paid_at`.
5. Add a `payment_reversed` event.
6. Reconcile customer credit.

### Adjust Balance (admin)

A positive delta increases debt; a negative delta reduces debt but cannot take balance below zero. The handler records a `balance_adjusted` event containing the signed delta and mandatory reason, updates lifecycle state, and reconciles customer credit atomically.

## Telegram Reminder Scheduler

Create `src/main/lib/loan-reminders.js` and start it from `main.js` only after DB/settings initialization. Skip automatic network work in smoke/e2e environments.

### Schedule

- Run shortly after startup.
- Run periodically (every 30 minutes) while the app remains open.
- Use an in-memory `running` promise/flag to prevent overlap.
- Clear the interval during shutdown.

### Eligibility

Select Loans where:

- `state='open'`
- `balance > 0`
- `due_date IS NOT NULL`
- Due Date is at most 15 days from local today (including all overdue dates)
- no `sent` reminder exists for Loan + local today

Paid/cancelled Loans and Legacy Balances without a Due Date are excluded.

### Delivery

For each eligible Loan:

1. Confirm `telegram_enabled='1'` and read token/chat ID in main only.
2. Check connectivity once per scheduler run.
3. Reserve/upsert today's reminder row and increment attempts.
4. Build escaped Telegram HTML containing profile, Loan, date/day count, balances, and concise item summary.
5. Send sequentially through the existing `sendMessage` helper.
6. Mark `sent` only after Telegram succeeds; otherwise mark `failed` with a sanitized error so a later run can retry.
7. Continue processing other Loans after one failure.

The scheduler sends only the current day's reminder after downtime, never one message for each missed day. Core app startup and transactions do not await Telegram delivery.

## Renderer UX

### Navigation

Add a shared **Utang** sidebar item near Point of Sale and load `js/utang.js` before `app.js`. It is visible to both roles.

### Utang page

The page uses the existing panel/table/modal conventions:

- summary cards: total outstanding, open Loans, due soon, overdue
- search and status filter
- customer/company list with name, contact, outstanding, nearest due, status
- **Add Customer/Company** button
- clicking a name opens a wide detail modal or detail pane

Customer detail contains:

- profile and credit summary
- Loans grouped newest first
- expandable purchased-item table
- payment and audit timelines
- **Record Payment** for both roles
- admin-only profile edit, active toggle, due-date edit, balance adjustment, and payment reversal

All dynamic strings use `App.ui.esc`; money/date rendering uses shared UI helpers. New classes are scoped under `.utang-*` and preserve the monochrome theme and responsive layout.

## Receipt Integration

`buildReceipt` includes `dueDate` from the sale. HTML and plain-text receipts show `Due:` only when `paymentMethod === 'account'` and the date exists. Existing non-account receipt output remains unchanged.

## Backup and Restore

Bump backup schema version to 2. Add `loans`, `loan_payments`, `loan_events`, and `loan_reminders` to export, sequence, and child-first wipe lists.

Import compatibility rules:

- Schema-v2 backups require all v2 tables.
- Schema-v1/older backups may omit new tables; treat them as empty, import known legacy tables, then run Legacy Balance migration/reconciliation.
- Rows from old tables may omit new additive columns; schema defaults fill them.
- Restore Loan children only after parent customers/sales/Loans are present.
- After import, call reconciliation so cached customer credit cannot disagree with open Loan balances.

## Error Handling and Operational Status

- Domain errors are concise and safe for cashier display.
- Telegram failures are sanitized and stored without tokens or full response payloads.
- Reminder status returns enabled/configured/online state, last success, and latest safe error only.
- Malformed one-Loan data is logged by Loan number without personal details, then other reminders continue.
- No Telegram failure can roll back or block a completed local sale/payment.

## Files Changed

### New

- `.kiro/specs/utang-loan-management/{requirements,design,tasks}.md`
- `src/main/lib/loans.js`
- `src/main/lib/loan-reminders.js`
- `src/main/ipc/loans.js`
- `src/renderer/js/utang.js`

### Existing

- `src/main/db/schema.sql`
- `src/main/db/index.js`
- `src/main/backup.js`
- `src/main/ipc/index.js`
- `src/main/ipc/sales.js`
- `src/main/preload.js`
- `src/main/lib/receipt.js`
- `src/main/main.js`
- `src/renderer/index.html`
- `src/renderer/js/pos.js`
- `src/renderer/css/app.css`
- `package.json`

## Validation Strategy

No new test suite is introduced unless separately requested. Validate the implementation with:

1. `npm run lint`
2. `npm test`
3. `npm run smoke`
4. focused temporary/manual IPC checks for migration, profile creation, account sale Loan creation, partial/full payment, reversal authorization, refund consistency, and reminder idempotency
5. packaged-independent UI inspection through existing Electron/Playwright tooling when practical
