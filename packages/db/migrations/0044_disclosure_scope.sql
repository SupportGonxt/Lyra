CREATE TABLE `compliance_disclosure_wordings` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`product_line` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`key` text NOT NULL,
	`wording` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compliance_disclosure_wordings_active_uq` ON `compliance_disclosure_wordings` (`tenant_id`,`product_line`,`locale`) WHERE status = 'active';--> statement-breakpoint
ALTER TABLE `signal_creatives` ADD `product_line` text;