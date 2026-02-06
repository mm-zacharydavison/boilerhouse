CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`pool_id` text,
	`container_id` text,
	`tenant_id` text,
	`message` text NOT NULL,
	`metadata` text,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_activity_log_timestamp` ON `activity_log` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_activity_log_event_type` ON `activity_log` (`event_type`);--> statement-breakpoint
CREATE TABLE `affinity_reservations` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`container_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_affinity_expires_at` ON `affinity_reservations` (`expires_at`);--> statement-breakpoint
CREATE TABLE `claims` (
	`container_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`last_activity` integer NOT NULL,
	`claimed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_claims_tenant` ON `claims` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `idx_claims_pool` ON `claims` (`pool_id`);--> statement-breakpoint
CREATE TABLE `pools` (
	`pool_id` text PRIMARY KEY NOT NULL,
	`workload_id` text NOT NULL,
	`min_size` integer NOT NULL,
	`max_size` integer NOT NULL,
	`idle_timeout_ms` integer NOT NULL,
	`eviction_interval_ms` integer NOT NULL,
	`acquire_timeout_ms` integer NOT NULL,
	`networks` text,
	`affinity_timeout_ms` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_errors` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`sync_id` text NOT NULL,
	`message` text NOT NULL,
	`mapping` text,
	`timestamp` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_sync_errors_tenant_sync` ON `sync_errors` (`tenant_id`,`sync_id`);--> statement-breakpoint
CREATE TABLE `sync_status` (
	`tenant_id` text NOT NULL,
	`sync_id` text NOT NULL,
	`last_sync_at` integer,
	`pending_count` integer DEFAULT 0 NOT NULL,
	`state` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `sync_id`)
);
