CREATE TABLE `signal_audience_members` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`audience_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`score` integer NOT NULL,
	`matched_json` text DEFAULT '[]' NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signal_audience_members_uq` ON `signal_audience_members` (`tenant_id`,`audience_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `signal_audience_members_customer_idx` ON `signal_audience_members` (`tenant_id`,`customer_id`);