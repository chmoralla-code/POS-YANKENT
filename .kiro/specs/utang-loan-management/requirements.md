# Utang / Loan Customer Management Requirements

## Introduction

YANKENT POS needs an offline-first Utang feature for managing customer and company credit accounts. Cashiers and administrators must be able to select or add a credit customer, complete an on-account sale with a due date, inspect the customer's personal information and purchased items, and record partial or full payments. Administrators must receive a Telegram reminder every local calendar day beginning 15 days before each open loan is due and continuing until the balance is paid or the loan is cancelled.

The feature extends the existing contractor and On-Account sale behavior. It must preserve existing installations, sales, customers, backups, role enforcement, inclusive-VAT totals, and offline operation.

## Glossary

- **Utang Customer**: An individual or company approved to make On-Account purchases.
- **Customer Profile**: Personal or company information associated with an Utang Customer.
- **Loan**: The receivable created from one completed On-Account sale, with its own principal, balance, due date, purchased items, and payment history.
- **Payment**: A partial or full amount received against one Loan. A Payment is not a new sale and must not increase sales revenue.
- **Outstanding Balance**: The unpaid portion of a Loan.
- **Due Soon**: An open Loan whose Due Date is between today and 15 local calendar days from today, inclusive.
- **Overdue**: An open Loan whose Due Date is earlier than today.
- **Reminder Day**: A local calendar date on which an eligible Loan may generate one successful Telegram reminder.
- **Legacy Balance**: Existing `customers.credit_used` data that predates individual Loan records.

## Requirements

### Requirement 1: Utang navigation and role access

**User Story:** As a cashier or administrator, I want a dedicated Utang page so that I can manage credit customers without leaving the POS application.

#### Acceptance Criteria

1. WHEN an authenticated cashier or administrator opens the application, THE System SHALL display an **Utang** navigation item.
2. WHEN either role opens the Utang page, THE System SHALL display customer/company names, total outstanding balance, nearest due date, and derived account status.
3. WHEN a user searches or filters the Utang list, THE System SHALL support matching by customer/company name, contact person, phone, loan number, or sale transaction number and filtering by open, due-soon, overdue, and paid status.
4. WHEN no matching records exist, THE System SHALL display an informative empty state without exposing an error.
5. IF an unauthenticated renderer or caller invokes an Utang endpoint, THEN THE System SHALL reject the request in the main process.

### Requirement 2: Customer and company profiles

**User Story:** As a cashier or administrator, I want to register an individual or company that uses credit so that the account can be selected during a sale.

#### Acceptance Criteria

1. WHEN either role selects **Add Customer/Company**, THE System SHALL accept entity type, customer/company name, contact person, phone, email, address, notes, and credit limit.
2. WHEN an individual is added, THE System SHALL require a customer name and allow the contact-person field to be omitted.
3. WHEN a company is added, THE System SHALL require both a company name and contact person.
4. WHEN a profile is submitted, THE System SHALL validate required fields, email format when supplied, and a finite non-negative credit limit in the main process.
5. WHEN a valid profile is created, THE System SHALL create an active contractor credit account that can immediately be selected for an On-Account sale.
6. WHEN a user clicks a customer/company name, THE System SHALL reveal its personal/company information, outstanding loans, purchased items, payment history, and account totals.
7. WHEN a cashier views a profile, THE System SHALL allow viewing and adding loans/payments but SHALL NOT expose edit, deactivate, balance-adjustment, payment-reversal, or due-date-change actions.
8. WHEN an administrator views a profile, THE System SHALL allow profile edits, due-date changes, deactivation/reactivation, balance adjustments, and payment reversals.
9. WHEN an administrator deactivates a profile, THE System SHALL retain all sales, loans, payments, and audit history but prevent new On-Account sales for that profile.
10. WHEN profile text is rendered, printed, logged, or sent through Telegram, THE System SHALL treat it as untrusted data and escape it for the destination.

### Requirement 3: Customer selection and On-Account checkout

**User Story:** As a cashier, I want to select a credit customer and due date at checkout so that the purchase becomes a traceable Loan.

#### Acceptance Criteria

1. WHEN preparing a sale, THE System SHALL provide a customer selector that includes active Utang Customers and identifies each customer's available credit.
2. WHEN no Utang Customer is selected, THE System SHALL prevent selection of the On-Account payment method.
3. WHEN On-Account is selected, THE System SHALL require a Due Date before creating the pending sale.
4. WHEN a new On-Account sale is submitted, THE System SHALL require its Due Date to be today or a future local calendar date.
5. WHEN an On-Account sale is created or committed, THE System SHALL verify in the main process that the customer exists, is active, is a contractor account, and has enough available credit.
6. WHEN the sale remains pending or is voided before printing, THE System SHALL NOT create a Loan or change the customer's outstanding balance.
7. WHEN the pending sale is committed, THE System SHALL atomically deduct stock, complete the sale, create exactly one Loan linked to that sale, and increase the customer's outstanding balance.
8. IF any operation in the commit transaction fails, THEN THE System SHALL roll back the stock, sale status, Loan, and balance changes together.
9. WHEN the committed receipt is displayed or printed, THE System SHALL include the customer/company name, On-Account payment method, and Due Date.
10. WHEN cash, card, or e-wallet is selected, THE System SHALL retain the existing checkout behavior and SHALL NOT require a Due Date or create a Loan.

### Requirement 4: Loan details and purchased-item history

**User Story:** As a cashier or administrator, I want to inspect each Loan so that I can answer questions about what was purchased, what remains due, and when payment is expected.

#### Acceptance Criteria

1. WHEN a customer profile is opened, THE System SHALL list each Loan with its loan number, sale transaction number, purchase date, Due Date, principal, amount paid, Outstanding Balance, and status.
2. WHEN a Loan is opened, THE System SHALL display the original sale's item names, SKUs, units, quantities, unit prices, and line totals.
3. WHEN a Loan has Payments, THE System SHALL display each Payment's amount, method, reference, note, timestamp, receiving user, and reversal status.
4. WHEN a Loan balance is zero, THE System SHALL identify it as Paid and record the date it became paid.
5. WHEN an open Loan is 1–15 days from its Due Date, THE System SHALL identify it as Due Soon and display the remaining days.
6. WHEN an open Loan is due today, THE System SHALL identify it as Due Today.
7. WHEN an open Loan is past its Due Date, THE System SHALL identify it as Overdue and display the overdue day count.
8. WHEN an administrator changes a Due Date, THE System SHALL validate the date, preserve the previous value in an audit record, and immediately recalculate the status and reminder eligibility.
9. WHEN multiple Loans belong to one customer, THE System SHALL maintain separate balances, due dates, purchased items, Payments, and reminders for each Loan.

### Requirement 5: Partial and full payments

**User Story:** As a cashier or administrator, I want to record payments against a specific Loan so that balances and payment history remain accurate.

#### Acceptance Criteria

1. WHEN recording a Payment, THE System SHALL require a specific open Loan, a finite positive amount, a supported payment method, and the receiving authenticated user.
2. WHEN the Payment amount exceeds the Loan's Outstanding Balance, THE System SHALL reject it rather than silently creating customer credit.
3. WHEN a valid Payment is recorded, THE System SHALL atomically append an immutable payment record, decrease the Loan balance, and decrease the customer's aggregate outstanding balance.
4. WHEN a Payment reduces the Loan balance to zero, THE System SHALL mark the Loan Paid and stop future reminders.
5. WHEN a Payment leaves a positive balance, THE System SHALL preserve the Loan as open and continue status/reminder calculations using the remaining balance.
6. WHEN a Payment is recorded, THE System SHALL NOT add the amount to sales revenue because the original On-Account sale already recorded the revenue.
7. WHEN an administrator reverses a Payment, THE System SHALL require a reason, mark the original Payment as reversed rather than deleting it, restore the Loan/customer balance atomically, and record the administrator and timestamp.
8. WHEN a cashier attempts to reverse a Payment or directly adjust a balance, THE System SHALL reject the request in the main process.
9. WHEN an administrator performs a manual balance adjustment, THE System SHALL require a reason and create an auditable adjustment record rather than rewriting history silently.

### Requirement 6: Refund and lifecycle consistency

**User Story:** As an administrator, I want refunds and account maintenance to remain consistent with Loan balances so that the ledger cannot diverge from sales.

#### Acceptance Criteria

1. WHEN a completed On-Account sale is fully refunded, THE System SHALL cancel the linked Loan, clear only its remaining Outstanding Balance from the customer aggregate, stop future reminders, and preserve prior Payments for audit.
2. WHEN an On-Account refund has prior Payments, THE System SHALL show those Payments in the cancelled Loan history and SHALL NOT create a negative balance.
3. WHEN a sale reset deletes sale history, THE System SHALL also remove or reset linked Loan, Payment, adjustment, reminder, and customer aggregate data within the same administrative operation.
4. WHEN a customer has historical activity, THE System SHALL use deactivation instead of destructive deletion.
5. WHEN any Loan-affecting transaction completes, THE System SHALL keep `customers.credit_used` equal to the sum of that customer's active outstanding Loan balances.

### Requirement 7: Telegram due-date reminders

**User Story:** As an administrator, I want Telegram notifications before and after a Loan is due so that I can follow up before balances become delinquent.

#### Acceptance Criteria

1. WHEN an open Loan has a positive balance and its Due Date is 15 or fewer local calendar days away, THE System SHALL make it eligible for a daily Telegram reminder.
2. WHEN an open Loan is overdue and still has a positive balance, THE System SHALL remain eligible for a daily Telegram reminder until it is Paid or cancelled.
3. WHEN an eligible reminder is sent successfully, THE System SHALL send it to the existing administrator Telegram bot/chat configuration and record the Loan and local Reminder Day.
4. WHEN a reminder record already exists for the same Loan and Reminder Day, THE System SHALL NOT send a duplicate reminder on application restart or repeated scheduler checks.
5. WHEN a reminder is sent, THE message SHALL include the customer/company name, contact information, loan number, sale transaction number, Due Date, days remaining or overdue, original principal, amount paid, Outstanding Balance, and a concise purchased-item summary.
6. WHEN Telegram is disabled, unconfigured, offline, or returns an error, THE System SHALL NOT mark the reminder as successfully sent and SHALL retry while the app remains open or on the next eligible application launch.
7. WHEN the POS starts and periodically while it remains open, THE System SHALL evaluate eligible reminders without requiring an authenticated renderer session.
8. WHEN the application was closed during one or more eligible days, THE System SHALL send at most the current day's reminder after reopening and SHALL NOT send a burst of historical missed reminders.
9. WHEN a Loan is Paid, cancelled, or no longer has a positive balance, THE System SHALL stop all future reminders for that Loan.
10. WHEN multiple scheduler checks overlap, THE System SHALL prevent concurrent duplicate sends for the same Loan and Reminder Day.
11. WHEN customer or item text is inserted into Telegram HTML, THE System SHALL escape it before sending.

### Requirement 8: Offline behavior and operational visibility

**User Story:** As a store operator, I want Utang management to work offline and explain reminder limitations so that normal selling is never blocked by internet access.

#### Acceptance Criteria

1. WHEN the computer has no internet, THE System SHALL continue to create profiles, commit On-Account sales, show Loan details, and record Payments locally.
2. WHEN Telegram is unavailable, THE System SHALL treat reminder failure as non-fatal and SHALL NOT block startup, login, checkout, payment recording, printing, or shutdown.
3. WHEN an administrator views the Utang page, THE System SHALL show the last successful reminder time and any current configuration/offline warning without revealing the Telegram token.
4. WHEN the app is not running, THE System SHALL make no claim that reminders can be sent; reminder delivery SHALL resume when the POS next runs and is online.
5. WHEN reminder processing encounters unexpected data, THE System SHALL isolate and log the affected Loan while continuing to evaluate other eligible Loans.

### Requirement 9: Migration, backup, and recovery

**User Story:** As an administrator, I want existing customer balances and backups preserved so that adding Utang management does not lose store data.

#### Acceptance Criteria

1. WHEN an existing database is opened after the feature is installed, THE System SHALL apply idempotent schema migration without deleting existing customers, sales, sale items, settings, or users.
2. WHEN an existing customer has a positive `credit_used` value but no Loan ledger, THE System SHALL create one Legacy Balance record equal to that value without inventing a Due Date.
3. WHEN a Legacy Balance lacks a Due Date, THE System SHALL label it **Due Date Required**, exclude it from Telegram reminders, and allow an administrator to assign a Due Date.
4. WHEN an existing customer has zero credit used, THE System SHALL NOT create a Legacy Balance record.
5. WHEN a backup is exported, THE System SHALL include customer profile fields, Loans, Payments, adjustments, reminder records, and their relationships.
6. WHEN a valid backup containing Utang data is restored, THE System SHALL restore that data and recalculate customer aggregate balances before normal operation resumes.
7. WHEN an older backup without Utang tables is restored, THE System SHALL accept it, apply migration, and preserve all data available in that backup.
8. IF imported or migrated aggregate balances disagree with open Loan balances, THEN THE System SHALL preserve an auditable Legacy Balance for the difference rather than discarding money silently.

### Requirement 10: Security, integrity, and compatibility

**User Story:** As the store owner, I want the feature to preserve YANKENT POS security and accounting behavior so that credit data cannot be manipulated from the renderer.

#### Acceptance Criteria

1. WHEN the renderer accesses Utang data, THE System SHALL use explicit `window.pos.*` preload methods and SHALL NOT expose direct database, filesystem, Node.js, or Telegram-token access.
2. WHEN a mutation is requested, THE System SHALL validate identifiers, dates, enum values, text lengths, and monetary values in the main process.
3. WHEN an admin-only action is requested, THE System SHALL enforce the admin role through the existing main-process guard regardless of renderer visibility.
4. WHEN money is calculated, THE System SHALL follow the existing two-decimal rounding rules and SHALL retain inclusive-VAT sale totals.
5. WHEN Loan, Payment, refund, adjustment, or migration writes affect more than one record, THE System SHALL perform them in a database transaction.
6. WHEN the application upgrades, THE System SHALL preserve existing Cash, Card, E-Wallet, printer, receipt, reporting, authentication, Telegram-report, and auto-backup behavior.
7. WHEN sensitive customer details are displayed, THE System SHALL reveal them only to authenticated cashiers or administrators and SHALL avoid writing them to ordinary diagnostic logs.
8. WHEN Telegram settings are read for reminders, THE System SHALL keep the bot token and chat identifier in the main process and SHALL NOT include the token in reminder records, renderer payloads, or logs.
