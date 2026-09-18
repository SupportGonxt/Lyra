ALTER TABLE `north_snapshots` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `north_snapshots` ADD `verified_by` text;--> statement-breakpoint
ALTER TABLE `north_snapshots` ADD `verification_ref` text;
