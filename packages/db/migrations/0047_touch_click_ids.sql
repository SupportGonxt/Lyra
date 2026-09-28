CREATE TABLE `signal_conversion_exports` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`touch_id` text NOT NULL,
	`connector_id` text NOT NULL,
	`provider` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`value_minor` integer,
	`currency` text,
	`attempts` integer DEFAULT 1 NOT NULL,
	`attempted_at` integer NOT NULL,
	`exported_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signal_conversion_exports_uq` ON `signal_conversion_exports` (`tenant_id`,`touch_id`,`connector_id`);--> statement-breakpoint
CREATE INDEX `signal_conversion_exports_tenant_idx` ON `signal_conversion_exports` (`tenant_id`,`attempted_at`);--> statement-breakpoint
ALTER TABLE `signal_attribution_events` ADD `gclid` text;--> statement-breakpoint
ALTER TABLE `signal_attribution_events` ADD `fbclid` text;