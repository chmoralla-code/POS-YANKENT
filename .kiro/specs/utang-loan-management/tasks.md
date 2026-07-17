# Utang / Loan Customer Management Implementation Tasks

- [x] 1. Add the Loan persistence foundation
  - [x] 1.1 Extend `customers` and `sales` in `schema.sql` with profile and Due Date fields.
  - [x] 1.2 Add `loans`, `loan_payments`, `loan_events`, and `loan_reminders` tables plus indexes.
  - [x] 1.3 Add idempotent additive migrations for existing installations.
  - [x] 1.4 Implement `lib/loans.js` validators, date/status helpers, Loan creation, detail hydration, and customer-credit reconciliation.
  - [x] 1.5 Bootstrap one undated Legacy Balance for each pre-feature customer with nonzero `credit_used`.
  - _Requirements: 3, 4, 5, 6, 9, 10_

- [x] 2. Make backups Loan-aware and backward compatible
  - [x] 2.1 Bump the backup schema version and include Loan tables in export/restore ordering.
  - [x] 2.2 Accept old backups that omit Loan tables and run migration/reconciliation after import.
  - [x] 2.3 Preserve IDs, sequence values, relationships, and customer aggregate balances.
  - _Requirements: 9, 10_

- [x] 3. Add secured Loan and profile APIs
  - [x] 3.1 Create `ipc/loans.js` with shared-role summary/list/detail/profile-create/payment endpoints.
  - [x] 3.2 Add admin-only profile update/activation, Due Date, adjustment, reversal, and manual reminder endpoints.
  - [x] 3.3 Validate all profile, date, enum, ID, and monetary inputs in the main process.
  - [x] 3.4 Register the module in `ipc/index.js` and expose explicit `window.pos.loans.*` methods in `preload.js`.
  - _Requirements: 1, 2, 4, 5, 8, 10_

- [x] 4. Integrate Loans with sales, receipts, refunds, and reset
  - [x] 4.1 Validate/store On-Account Due Dates during pending-sale creation.
  - [x] 4.2 Create exactly one linked Loan atomically when an On-Account sale commits.
  - [x] 4.3 Reconcile Loan/customer balances when an account sale is refunded.
  - [x] 4.4 Delete/reset Loan children consistently during the existing destructive sales reset.
  - [x] 4.5 Include Due Date on account receipt objects, previews, and thermal receipt text.
  - _Requirements: 3, 5, 6, 10_

- [x] 5. Implement automatic Telegram reminders
  - [x] 5.1 Create `lib/loan-reminders.js` with eligibility, escaped message formatting, and per-Loan/per-day idempotency.
  - [x] 5.2 Respect existing Telegram enabled/token/chat settings while keeping credentials in the main process.
  - [x] 5.3 Start a non-blocking startup/30-minute scheduler in `main.js`, skip it in test modes, and stop it during shutdown.
  - [x] 5.4 Persist success/failure status and expose only sanitized operational status to authenticated users.
  - _Requirements: 7, 8, 10_

- [x] 6. Add the shared cashier/admin Utang interface
  - [x] 6.1 Create the `utang.js` view skeleton and add shared navigation/script registration.
  - [x] 6.2 Build summary cards, search/status filtering, customer list, and empty/loading states.
  - [x] 6.3 Build Add Customer/Company and admin profile-edit/deactivation forms.
  - [x] 6.4 Build customer detail with personal information, per-Loan purchased items, payments, events, balances, and statuses.
  - [x] 6.5 Build payment recording plus admin-only Due Date, adjustment, and reversal actions.
  - [x] 6.6 Add responsive monochrome `.utang-*` styles in `app.css`.
  - _Requirements: 1, 2, 4, 5, 8, 10_

- [x] 7. Make On-Account checkout usable from the POS
  - [x] 7.1 Add active credit-customer selection and available-credit display to Current Sale.
  - [x] 7.2 Add a quick profile-create action shared with the Utang workflow.
  - [x] 7.3 Require and submit a Due Date only for On-Account payment.
  - [x] 7.4 Refresh selected customer/credit state after commit, payment, void, and profile changes.
  - _Requirements: 2, 3, 6_

- [x] 8. Integrate syntax scripts and validate behavior
  - [x] 8.1 Add new production modules to the existing `npm run lint` syntax checks.
  - [x] 8.2 Run `npm run lint`, `npm test`, and `npm run smoke`.
  - [x] 8.3 Exercise migration and focused Loan IPC flows: create profile, account sale, partial/full payment, cashier authorization boundaries, admin reversal/adjustment, refund, and reminder idempotency.
  - [x] 8.4 Fix all regressions and confirm the working tree contains only intended feature/spec changes.
  - _Requirements: 1–10_
