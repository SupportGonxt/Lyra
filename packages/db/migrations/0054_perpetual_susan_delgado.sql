CREATE TABLE `signal_brand_kits` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`required_phrases_json` text DEFAULT '[]' NOT NULL,
	`forbidden_words_json` text DEFAULT '[]' NOT NULL,
	`banned_claims_json` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signal_brand_kits_uq` ON `signal_brand_kits` (`tenant_id`);