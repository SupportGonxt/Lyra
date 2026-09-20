ALTER TABLE `dist_commission_rates` ADD `structure_json` text;--> statement-breakpoint
ALTER TABLE `ledger_accounts` ADD `suspense` integer DEFAULT false NOT NULL;