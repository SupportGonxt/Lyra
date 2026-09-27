CREATE TABLE `axis_reinsurance_cessions` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`policy_id` text NOT NULL,
	`treaty_id` text NOT NULL,
	`reinsurer_id` text NOT NULL,
	`kind` text NOT NULL,
	`currency` text NOT NULL,
	`premium_minor` integer NOT NULL,
	`sum_insured_minor` integer,
	`ceded_premium_minor` integer NOT NULL,
	`ceded_sum_insured_minor` integer,
	`ceding_commission_minor` integer NOT NULL,
	`net_payable_minor` integer NOT NULL,
	`retained_premium_minor` integer NOT NULL,
	`state` text DEFAULT 'pending_approval' NOT NULL,
	`txn_id` text,
	`posted_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `axis_ri_cessions_policy_treaty_uq` ON `axis_reinsurance_cessions` (`tenant_id`,`policy_id`,`treaty_id`);--> statement-breakpoint
CREATE INDEX `axis_ri_cessions_state_idx` ON `axis_reinsurance_cessions` (`tenant_id`,`state`,`treaty_id`);--> statement-breakpoint
CREATE TABLE `axis_reinsurance_treaties` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`ref` text NOT NULL,
	`reinsurer_id` text NOT NULL,
	`kind` text NOT NULL,
	`product_line` text,
	`currency` text NOT NULL,
	`ceded_share_ppm` integer,
	`limit_minor` integer,
	`retention_minor` integer,
	`lines` integer,
	`ceding_commission_ppm` integer DEFAULT 0 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`effective_from` integer NOT NULL,
	`effective_to` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `axis_ri_treaties_ref_uq` ON `axis_reinsurance_treaties` (`tenant_id`,`ref`);--> statement-breakpoint
CREATE INDEX `axis_ri_treaties_status_idx` ON `axis_reinsurance_treaties` (`tenant_id`,`status`,`product_line`);