CREATE TABLE `core_links` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`note_id` text NOT NULL,
	`from_ref` text NOT NULL,
	`to_ref` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `core_links_note_to_uq` ON `core_links` (`tenant_id`,`note_id`,`to_ref`);--> statement-breakpoint
CREATE INDEX `core_links_to_idx` ON `core_links` (`tenant_id`,`to_ref`);--> statement-breakpoint
CREATE INDEX `core_links_from_idx` ON `core_links` (`tenant_id`,`from_ref`);--> statement-breakpoint
CREATE TABLE `core_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`subject_ref` text NOT NULL,
	`body_md` text NOT NULL,
	`author_ref` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `core_notes_subject_uq` ON `core_notes` (`tenant_id`,`subject_ref`);