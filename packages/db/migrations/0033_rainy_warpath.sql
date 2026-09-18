CREATE TABLE `orbit_deflections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`question` text NOT NULL,
	`article_id` text,
	`score` integer NOT NULL,
	`outcome` text NOT NULL,
	`via` text DEFAULT 'lexical' NOT NULL,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `orbit_deflections_tenant_idx` ON `orbit_deflections` (`tenant_id`,`ts`);--> statement-breakpoint
CREATE INDEX `orbit_deflections_conversation_idx` ON `orbit_deflections` (`tenant_id`,`conversation_id`);--> statement-breakpoint
CREATE TABLE `orbit_kb_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`vector_id` text,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orbit_kb_articles_key_uq` ON `orbit_kb_articles` (`tenant_id`,`key`,`locale`);--> statement-breakpoint
CREATE INDEX `orbit_kb_articles_status_idx` ON `orbit_kb_articles` (`tenant_id`,`status`,`locale`);--> statement-breakpoint
CREATE TABLE `orbit_macros` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`key` text NOT NULL,
	`name_json` text NOT NULL,
	`body_json` text NOT NULL,
	`category` text,
	`article_id` text,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orbit_macros_key_uq` ON `orbit_macros` (`tenant_id`,`key`);--> statement-breakpoint
ALTER TABLE `ledger_periods` ADD `state_reason` text;--> statement-breakpoint
ALTER TABLE `ledger_recon_matches` ADD `settlement_txn_id` text;--> statement-breakpoint
ALTER TABLE `north_snapshots` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `north_snapshots` ADD `verified_by` text;--> statement-breakpoint
ALTER TABLE `north_snapshots` ADD `verification_ref` text;