CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`plan` text DEFAULT 'free' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`stripe_customer_id` text,
	`stripe_subscription_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`email` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'owner' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `org_id` text DEFAULT 'org_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `api_keys` ADD `org_id` text DEFAULT 'org_default' NOT NULL;--> statement-breakpoint
ALTER TABLE `ui_sessions` ADD `user_id` text;--> statement-breakpoint
ALTER TABLE `webhooks` ADD `org_id` text DEFAULT 'org_default' NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `orgs` (`id`, `name`, `plan`, `status`, `created_at`) VALUES ('org_default', 'Default', 'pro', 'active', 0);
