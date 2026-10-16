CREATE TABLE `signal_creative_publishes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`creative_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text,
	`status` text NOT NULL,
	`error` text,
	`published_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signal_creative_publishes_uq` ON `signal_creative_publishes` (`tenant_id`,`creative_id`,`provider`);--> statement-breakpoint
CREATE INDEX `signal_creative_publishes_creative_idx` ON `signal_creative_publishes` (`tenant_id`,`creative_id`,`status`);