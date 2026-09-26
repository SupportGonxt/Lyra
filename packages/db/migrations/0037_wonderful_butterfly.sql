-- Table rebuild: customer_id becomes nullable and partner_id arrives (partner journeys).
-- No foreign key touches this table, so no PRAGMA is needed (D1 runs each migration in a transaction).
CREATE TABLE `__new_orbit_journey_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`journey_id` text NOT NULL,
	`customer_id` text,
	`partner_id` text,
	`node` text NOT NULL,
	`state` text DEFAULT 'running' NOT NULL,
	`context_json` text,
	`next_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_orbit_journey_runs`("id", "tenant_id", "journey_id", "customer_id", "partner_id", "node", "state", "context_json", "next_at", "created_at", "updated_at") SELECT "id", "tenant_id", "journey_id", "customer_id", NULL, "node", "state", "context_json", "next_at", "created_at", "updated_at" FROM `orbit_journey_runs`;--> statement-breakpoint
DROP TABLE `orbit_journey_runs`;--> statement-breakpoint
ALTER TABLE `__new_orbit_journey_runs` RENAME TO `orbit_journey_runs`;--> statement-breakpoint
CREATE INDEX `orbit_journey_runs_due_idx` ON `orbit_journey_runs` (`tenant_id`,`state`,`next_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `orbit_journey_runs_uq` ON `orbit_journey_runs` (`tenant_id`,`journey_id`,`customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `orbit_journey_runs_partner_uq` ON `orbit_journey_runs` (`tenant_id`,`journey_id`,`partner_id`);