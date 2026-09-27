PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_dist_commission_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`policy_id` text,
	`sale_ref` text,
	`offering_id` text,
	`provider_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`rate_id` text,
	`kind` text DEFAULT 'new_business' NOT NULL,
	`premium_minor` integer NOT NULL,
	`gross_commission_minor` integer NOT NULL,
	`channel_commission_minor` integer DEFAULT 0 NOT NULL,
	`net_commission_minor` integer NOT NULL,
	`tax_minor` integer DEFAULT 0 NOT NULL,
	`currency` text NOT NULL,
	`earned_on` text DEFAULT 'issue' NOT NULL,
	`earned_at` integer,
	`reversal_of` text,
	`provider_settlement_id` text,
	`channel_settlement_id` text,
	`txn_id` text,
	`state` text DEFAULT 'accrued' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_dist_commission_entries`("id", "tenant_id", "policy_id", "sale_ref", "offering_id", "provider_id", "channel_id", "rate_id", "kind", "premium_minor", "gross_commission_minor", "channel_commission_minor", "net_commission_minor", "tax_minor", "currency", "earned_on", "earned_at", "reversal_of", "provider_settlement_id", "channel_settlement_id", "txn_id", "state", "created_at", "updated_at") SELECT "id", "tenant_id", "policy_id", NULL, "offering_id", "provider_id", "channel_id", "rate_id", "kind", "premium_minor", "gross_commission_minor", "channel_commission_minor", "net_commission_minor", "tax_minor", "currency", "earned_on", "earned_at", "reversal_of", "provider_settlement_id", "channel_settlement_id", "txn_id", "state", "created_at", "updated_at" FROM `dist_commission_entries`;--> statement-breakpoint
DROP TABLE `dist_commission_entries`;--> statement-breakpoint
ALTER TABLE `__new_dist_commission_entries` RENAME TO `dist_commission_entries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `dist_commission_entries_accrual_uq` ON `dist_commission_entries` (`tenant_id`,`policy_id`,`kind`) WHERE kind != 'clawback';--> statement-breakpoint
CREATE UNIQUE INDEX `dist_commission_entries_sale_uq` ON `dist_commission_entries` (`tenant_id`,`sale_ref`,`kind`) WHERE kind != 'clawback' and sale_ref is not null;--> statement-breakpoint
CREATE INDEX `dist_commission_entries_idx` ON `dist_commission_entries` (`tenant_id`,`state`,`earned_at`);--> statement-breakpoint
CREATE INDEX `dist_commission_entries_policy_idx` ON `dist_commission_entries` (`tenant_id`,`policy_id`);--> statement-breakpoint
CREATE INDEX `dist_commission_entries_provider_idx` ON `dist_commission_entries` (`tenant_id`,`provider_id`,`state`);--> statement-breakpoint
CREATE INDEX `dist_commission_entries_channel_idx` ON `dist_commission_entries` (`tenant_id`,`channel_id`,`state`);--> statement-breakpoint
ALTER TABLE `dist_quote_responses` ADD `sold_at` integer;