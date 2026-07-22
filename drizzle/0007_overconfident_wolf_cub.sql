CREATE TABLE `activity_log` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text DEFAULT 'org_default' NOT NULL,
	`account_id` text,
	`account_email` text,
	`category` text NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`error` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_org_created` ON `activity_log` (`org_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_account_created` ON `activity_log` (`account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `activity_status_created` ON `activity_log` (`status`,`created_at`);