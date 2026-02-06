CREATE TABLE `containers` (
	`container_id` text PRIMARY KEY NOT NULL,
	`pool_id` text NOT NULL,
	`status` text NOT NULL,
	`tenant_id` text,
	`last_activity` integer NOT NULL,
	`claimed_at` integer,
	`idle_expires_at` integer,
	`affinity_expires_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_containers_pool` ON `containers` (`pool_id`);--> statement-breakpoint
CREATE INDEX `idx_containers_status` ON `containers` (`pool_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_containers_tenant` ON `containers` (`tenant_id`);--> statement-breakpoint
DROP TABLE `claims`;--> statement-breakpoint
DROP TABLE `affinity_reservations`;
