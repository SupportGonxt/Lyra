-- ADR-0125: a placement names the market and the licence it was made under.
--
-- `MARKETS` and `REGULATORS` (packages/core/src/operating-model.ts) held the
-- broker's two real licence numbers and no route, engine or screen read them:
-- AXIS could place a risk in any market and record nowhere which licence it was
-- placed under. This is the tenant-owned register the bind seam reads.
--
-- `scope` is `RegulatorDef["scope"]` and `status` is
-- `active|suspended|expired`; both are text unions in production code, the same
-- way `status` on axis_policies is (POLICY_STATES in packages/core/src/lifecycle.ts
-- is the authority). `product_lines_json` holds operating-model line keys.
CREATE TABLE `axis_authorisations` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`market` text NOT NULL,
	`regulator_key` text NOT NULL,
	`licence_number` text NOT NULL,
	`scope` text NOT NULL,
	`product_lines_json` text NOT NULL,
	`valid_from` integer NOT NULL,
	`valid_to` integer,
	`evidence_file_id` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `axis_authorisations_market_idx` ON `axis_authorisations` (`tenant_id`,`market`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `axis_authorisations_licence_uq` ON `axis_authorisations` (`tenant_id`,`regulator_key`,`licence_number`);
