CREATE TABLE `axis_authorisations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`market` text NOT NULL,
	`regulator_key` text NOT NULL,
	`licence_number` text NOT NULL,
	`scope` text NOT NULL,
	`product_lines_json` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`evidence_file_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `axis_authorisations_market_idx` ON `axis_authorisations` (`tenant_id`,`market`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `axis_authorisations_licence_uq` ON `axis_authorisations` (`tenant_id`,`regulator_key`,`licence_number`);--> statement-breakpoint
CREATE TABLE `north_metric_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`definition_sql_ref` text NOT NULL,
	`changed_at` integer NOT NULL,
	`changed_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `north_metric_definitions_key_idx` ON `north_metric_definitions` (`tenant_id`,`metric_key`,`changed_at`);--> statement-breakpoint
ALTER TABLE `axis_documents` ADD `wording_json` text;--> statement-breakpoint
ALTER TABLE `axis_policies` ADD `market` text;--> statement-breakpoint
ALTER TABLE `dist_quote_responses` ADD `breakdown_json` text;--> statement-breakpoint
ALTER TABLE `ledger_accounts` ADD `client_money_pair` text;--> statement-breakpoint
ALTER TABLE `ledger_client_money_checks` ADD `account_code` text;--> statement-breakpoint
ALTER TABLE `ledger_client_money_checks` ADD `liability_code` text;

--> statement-breakpoint
-- Data backfill, which `drizzle-kit generate` cannot produce: it diffs **schema**, and
-- the pairing a client-money account already had is a fact about existing rows.
--
-- **This is the part that matters for a tenant seeded before this column existed.** The
-- seed writes `client_money_pair` directly for a new tenant, so a fresh database needs
-- none of this — but every deployed tenant's 1010/2010 (and the KSA pair) would hold
-- NULL, `clientMoneyPairs` would find **no pairs**, and the segregation invariant would
-- check nothing at all while every test passed. The same shape as the authorisation
-- register needing a backfill for tenants provisioned before it.
--
-- Idempotent: each statement matches on the code and only sets rows that are
-- client-money flagged, so a second run is a no-op.
UPDATE `ledger_accounts` SET `client_money_pair` = '2010' WHERE `code` = '1010' AND `client_money` = 1;--> statement-breakpoint
UPDATE `ledger_accounts` SET `client_money_pair` = '1010' WHERE `code` = '2010' AND `client_money` = 1;--> statement-breakpoint
UPDATE `ledger_accounts` SET `client_money_pair` = '2011' WHERE `code` = '1011' AND `client_money` = 1;--> statement-breakpoint
UPDATE `ledger_accounts` SET `client_money_pair` = '1011' WHERE `code` = '2011' AND `client_money` = 1;
