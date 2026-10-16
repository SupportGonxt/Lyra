CREATE TABLE `signal_aeo_citations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`page_id` text,
	`query` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`assistant` text NOT NULL,
	`cited` integer NOT NULL,
	`cited_domains_json` text,
	`excerpt` text,
	`sampled_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `signal_aeo_citations_idx` ON `signal_aeo_citations` (`tenant_id`,`sampled_at`);--> statement-breakpoint
CREATE INDEX `signal_aeo_citations_page_idx` ON `signal_aeo_citations` (`tenant_id`,`page_id`,`sampled_at`);