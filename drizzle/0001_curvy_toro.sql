PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_send_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`source` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`raw_path` text,
	`envelope_json` text NOT NULL,
	`subject` text,
	`message_id` text,
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
INSERT INTO `__new_send_jobs`("id", "account_id", "source", "status", "raw_path", "envelope_json", "subject", "message_id", "attempts", "max_attempts", "next_attempt_at", "locked_at", "locked_by", "provider_message_id", "last_error", "created_at", "sent_at") SELECT "id", "account_id", "source", "status", "raw_path", "envelope_json", "subject", NULL, "attempts", "max_attempts", "next_attempt_at", "locked_at", "locked_by", "provider_message_id", "last_error", "created_at", "sent_at" FROM `send_jobs`;--> statement-breakpoint
DROP TABLE `send_jobs`;--> statement-breakpoint
ALTER TABLE `__new_send_jobs` RENAME TO `send_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `send_jobs_status_next` ON `send_jobs` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `send_jobs_account_created` ON `send_jobs` (`account_id`,`created_at`);