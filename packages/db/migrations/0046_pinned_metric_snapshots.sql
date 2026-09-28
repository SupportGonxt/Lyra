CREATE TABLE `ledger_metric_pins` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`source_snapshot_id` text NOT NULL,
	`metric_key` text NOT NULL,
	`grain` text NOT NULL,
	`period` text NOT NULL,
	`dims_hash` text NOT NULL,
	`value` integer NOT NULL,
	`unit` text NOT NULL,
	`currency` text,
	`source_verified_by` text NOT NULL,
	`source_verified_at` integer NOT NULL,
	`source_hash` text NOT NULL,
	`state` text DEFAULT 'pinned' NOT NULL,
	`pinned_by` text NOT NULL,
	`pinned_at` integer NOT NULL,
	`tenant_signed_by` text,
	`tenant_signed_at` integer,
	`counterparty_signed_by` text,
	`counterparty_signed_at` integer,
	`counterparty_evidence_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ledger_metric_pins_source_uq` ON `ledger_metric_pins` (`tenant_id`,`source_snapshot_id`);