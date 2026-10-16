CREATE TABLE `dist_payments` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_ref` text NOT NULL,
	`provider` text NOT NULL,
	`provider_ref` text,
	`amount_minor` integer NOT NULL,
	`currency` text NOT NULL,
	`state` text DEFAULT 'created' NOT NULL,
	`redirect_url` text,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `dist_payments_provider_ref_uq` ON `dist_payments` (`tenant_id`,`provider`,`provider_ref`);--> statement-breakpoint
CREATE INDEX `dist_payments_subject_idx` ON `dist_payments` (`tenant_id`,`subject_ref`,`created_at`);