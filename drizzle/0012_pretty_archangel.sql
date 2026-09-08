CREATE TABLE `warmup_accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'off' NOT NULL,
	`ramp_day` integer DEFAULT 0 NOT NULL,
	`ramp_advanced_date` text,
	`started_at` integer,
	`settings_json` text,
	`persona_json` text,
	`last_planned_date` text,
	`today_target` integer DEFAULT 0 NOT NULL,
	`throttle_percent` integer DEFAULT 100 NOT NULL,
	`clean_days` integer DEFAULT 0 NOT NULL,
	`paused_until` integer,
	`pause_reason` text,
	`last_spam_sweep_at` integer,
	`spam_seen_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `warmup_landings` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`from_account_id` text NOT NULL,
	`to_account_id` text NOT NULL,
	`local_date` text NOT NULL,
	`landed` text,
	`landed_at` integer,
	`provider_message_id` text,
	`rescued_at` integer,
	`category_fixed_at` integer,
	`read_at` integer,
	`starred_at` integer,
	`important_at` integer,
	`receipt_sent_at` integer,
	`replied_at` integer,
	`forwarded_at` integer,
	`cleaned_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warmup_landings_message_to` ON `warmup_landings` (`message_id`,`to_account_id`);--> statement-breakpoint
CREATE INDEX `warmup_landings_to` ON `warmup_landings` (`to_account_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `warmup_landings_from_date` ON `warmup_landings` (`from_account_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `warmup_landings_pending` ON `warmup_landings` (`landed`,`created_at`);--> statement-breakpoint
CREATE TABLE `warmup_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`turn` integer NOT NULL,
	`kind` text NOT NULL,
	`from_account_id` text NOT NULL,
	`to_account_id` text NOT NULL,
	`cc_account_ids_json` text,
	`rfc_message_id` text NOT NULL,
	`in_reply_to_message_id` text,
	`subject` text NOT NULL,
	`body_text` text,
	`send_job_id` text,
	`content_source` text DEFAULT 'template' NOT NULL,
	`requested_receipt` integer DEFAULT 0 NOT NULL,
	`local_date` text NOT NULL,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`failed_at` integer,
	`fail_error` text,
	`expected_by` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warmup_messages_rfc_id` ON `warmup_messages` (`rfc_message_id`);--> statement-breakpoint
CREATE INDEX `warmup_messages_from_date` ON `warmup_messages` (`from_account_id`,`local_date`);--> statement-breakpoint
CREATE INDEX `warmup_messages_thread` ON `warmup_messages` (`thread_id`,`turn`);--> statement-breakpoint
CREATE INDEX `warmup_messages_send_job` ON `warmup_messages` (`send_job_id`);--> statement-breakpoint
CREATE TABLE `warmup_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`language` text NOT NULL,
	`register` text NOT NULL,
	`topic` text,
	`subject` text NOT NULL,
	`turns_json` text NOT NULL,
	`source` text NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`retired` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `warmup_scripts_pick` ON `warmup_scripts` (`language`,`register`,`retired`,`used_count`);--> statement-breakpoint
CREATE TABLE `warmup_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`counterparty_account_id` text,
	`kind` text NOT NULL,
	`due_at` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`locked_at` integer,
	`locked_by` text,
	`last_error` text,
	`created_at` integer NOT NULL,
	`done_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `warmup_tasks_idempotency` ON `warmup_tasks` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `warmup_tasks_status_due` ON `warmup_tasks` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `warmup_tasks_account_kind` ON `warmup_tasks` (`account_id`,`kind`,`due_at`);--> statement-breakpoint
CREATE INDEX `warmup_tasks_counterparty` ON `warmup_tasks` (`counterparty_account_id`,`kind`,`due_at`);--> statement-breakpoint
CREATE TABLE `warmup_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'conversation' NOT NULL,
	`initiator_account_id` text NOT NULL,
	`participants_json` text NOT NULL,
	`subject` text NOT NULL,
	`script_id` text,
	`language` text DEFAULT 'en' NOT NULL,
	`turns_planned` integer NOT NULL,
	`turns_done` integer DEFAULT 0 NOT NULL,
	`state` text DEFAULT 'active' NOT NULL,
	`human_replied_at` integer,
	`internal` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `warmup_threads_initiator` ON `warmup_threads` (`initiator_account_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `imap_messages` ADD `warmup` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orgs` ADD `warmup_defaults_json` text;--> statement-breakpoint
ALTER TABLE `orgs` ADD `warmup_pool_scope` text DEFAULT 'instance' NOT NULL;--> statement-breakpoint
ALTER TABLE `orgs` ADD `warmup_filter_tag` text;--> statement-breakpoint
ALTER TABLE `orgs` ADD `warmup_old_tags_json` text;--> statement-breakpoint
ALTER TABLE `orgs` ADD `warmup_emit_webhooks` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `orgs` ADD `warmup_show_in_send_log` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `send_jobs` ADD `warmup_message_id` text;