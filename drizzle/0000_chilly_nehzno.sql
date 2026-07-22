CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_email` ON `accounts` (`provider`,`email`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_prefix` text NOT NULL,
	`key_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_unique` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE TABLE `oauth_tokens` (
	`account_id` text PRIMARY KEY NOT NULL,
	`access_token_enc` text NOT NULL,
	`refresh_token_enc` text NOT NULL,
	`expires_at` integer NOT NULL,
	`scopes` text NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `send_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`raw_path` text NOT NULL,
	`envelope_json` text NOT NULL,
	`subject` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`locked_at` integer,
	`locked_by` text,
	`provider_message_id` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `send_jobs_status_next` ON `send_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `send_jobs_account_created` ON `send_jobs` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `smtp_credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `smtp_credentials_username_unique` ON `smtp_credentials` (`username`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`account_id` text PRIMARY KEY NOT NULL,
	`cursor` text,
	`last_polled_at` integer,
	`last_error` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ui_sessions` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`locked_at` integer,
	`response_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `webhook_deliveries_status_next` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text,
	`url` text NOT NULL,
	`secret_enc` text NOT NULL,
	`events` text DEFAULT '["message.received"]' NOT NULL,
	`active` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
