CREATE TABLE `signal_prospects` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`reason` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`source_ref` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signal_prospects_uq` ON `signal_prospects` (`tenant_id`,`customer_id`,`reason`);--> statement-breakpoint
CREATE INDEX `signal_prospects_reason_idx` ON `signal_prospects` (`tenant_id`,`reason`,`state`,`score`);--> statement-breakpoint
CREATE TABLE `signal_responses` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`campaign_id` text,
	`audience_id` text,
	`customer_id` text,
	`outreach_id` text,
	`kind` text NOT NULL,
	`ref` text,
	`ts` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `signal_responses_uq` ON `signal_responses` (`tenant_id`,`outreach_id`,`kind`);--> statement-breakpoint
CREATE INDEX `signal_responses_campaign_idx` ON `signal_responses` (`tenant_id`,`campaign_id`,`ts`);--> statement-breakpoint
CREATE INDEX `signal_responses_customer_idx` ON `signal_responses` (`tenant_id`,`customer_id`,`ts`);--> statement-breakpoint
ALTER TABLE `signal_outreach` ADD `conversation_id` text;--> statement-breakpoint
CREATE INDEX `signal_outreach_conversation_idx` ON `signal_outreach` (`tenant_id`,`conversation_id`,`ts`);--> statement-breakpoint
CREATE INDEX `signal_outreach_ext_idx` ON `signal_outreach` (`tenant_id`,`external_ref`);