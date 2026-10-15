-- docs/modules/north.md §8: "A metric definition change shows as a chart annotation
-- from the change date." `north_metrics` carried `definition_sql_ref` and
-- `updated_at` and no history, so only the *last* change was knowable and nothing
-- said what changed. Append-only, like every other trail table here: a row is
-- written when the value differs, never edited, never deleted.
CREATE TABLE `north_metric_definitions` (
  `id` text PRIMARY KEY NOT NULL,
  `tenant_id` text NOT NULL,
  `metric_key` text NOT NULL,
  `definition_sql_ref` text NOT NULL,
  `changed_at` integer NOT NULL,
  `changed_by` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `north_metric_definitions_key_idx` ON `north_metric_definitions` (`tenant_id`,`metric_key`,`changed_at`);
