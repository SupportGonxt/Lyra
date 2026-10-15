-- ADR-0126: client money is segregated per licence, per market.
--
-- `ledger_accounts.client_money` has always allowed a second client-money
-- account, but every *control* over it was written against the two literals
-- 1010 and 2010: the posting-time invariant (packages/ledger/src/posting.ts),
-- the position report (packages/ledger/src/reports.ts) and the period-close
-- check (packages/ledger/src/periods.ts) all read those two codes. A second
-- account's shortfall was therefore invisible, and a batch could debit one
-- market's float while crediting another market's client liability without any
-- check noticing — summing the two liabilities to nothing.
--
-- `client_money_pair` is the pairing: on a client-money asset it names the
-- liability that holds the same clients' money, and on that liability it names
-- the asset back. The invariant is then evaluated per pair. The column is not
-- `parent_code`, which is a chart-of-accounts hierarchy and already means
-- something else (apps/web/app/modules/ledger.ts declares it as "Parent
-- account"); pointing a liability at an asset through it would be a column
-- holding something other than what its name says, which is the recurring
-- defect this repo names a dead seam.
--
-- `ledger_client_money_checks.account_code`/`liability_code` are the account
-- that was short, recorded on the alarm row itself. Without them the row says
-- only "client money is short" and the period-close check cannot name the
-- market, which is the one thing the controller reading it needs.
ALTER TABLE `ledger_accounts` ADD `client_money_pair` text;--> statement-breakpoint
ALTER TABLE `ledger_client_money_checks` ADD `account_code` text;--> statement-breakpoint
ALTER TABLE `ledger_client_money_checks` ADD `liability_code` text;--> statement-breakpoint
UPDATE `ledger_accounts` SET `client_money_pair` = '2010' WHERE `code` = '1010' AND `client_money` = 1;--> statement-breakpoint
UPDATE `ledger_accounts` SET `client_money_pair` = '1010' WHERE `code` = '2010' AND `client_money` = 1;--> statement-breakpoint
UPDATE `ledger_accounts` SET `client_money_pair` = '2011' WHERE `code` = '1011' AND `client_money` = 1;--> statement-breakpoint
UPDATE `ledger_accounts` SET `client_money_pair` = '1011' WHERE `code` = '2011' AND `client_money` = 1;
