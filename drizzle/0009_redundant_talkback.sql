ALTER TABLE `send_jobs` ADD `bounced_at` integer;--> statement-breakpoint
ALTER TABLE `send_jobs` ADD `bounce_type` text;--> statement-breakpoint
ALTER TABLE `send_jobs` ADD `bounce_code` text;--> statement-breakpoint
ALTER TABLE `send_jobs` ADD `bounce_recipient` text;--> statement-breakpoint
ALTER TABLE `send_jobs` ADD `bounce_diagnostic` text;--> statement-breakpoint
ALTER TABLE `send_jobs` ADD `replied_at` integer;--> statement-breakpoint
ALTER TABLE `send_jobs` ADD `reply_message_id` text;--> statement-breakpoint
CREATE INDEX `send_jobs_message_id` ON `send_jobs` (`message_id`);