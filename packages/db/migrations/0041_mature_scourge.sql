CREATE TABLE `ledger_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`account_code` text NOT NULL,
	`period` text NOT NULL,
	`currency` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_budgets_uq` ON `ledger_budgets` (`tenant_id`,`period`,`account_code`,`currency`);