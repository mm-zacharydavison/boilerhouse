ALTER TABLE `containers` ADD `last_tenant_id` text;--> statement-breakpoint
ALTER TABLE `containers` DROP COLUMN `affinity_expires_at`;--> statement-breakpoint
ALTER TABLE `pools` DROP COLUMN `affinity_timeout_ms`;
