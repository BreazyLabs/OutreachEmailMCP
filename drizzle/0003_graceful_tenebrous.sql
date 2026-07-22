CREATE TABLE `imap_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`folder` text DEFAULT 'INBOX' NOT NULL,
	`uid` integer NOT NULL,
	`provider_message_id` text NOT NULL,
	`internal_date` integer NOT NULL,
	`size` integer NOT NULL,
	`envelope_json` text NOT NULL,
	`seen` integer DEFAULT 0 NOT NULL,
	`answered` integer DEFAULT 0 NOT NULL,
	`flagged` integer DEFAULT 0 NOT NULL,
	`deleted` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `imap_messages_account_folder_uid` ON `imap_messages` (`account_id`,`folder`,`uid`);--> statement-breakpoint
CREATE UNIQUE INDEX `imap_messages_account_provider` ON `imap_messages` (`account_id`,`provider_message_id`);--> statement-breakpoint
CREATE INDEX `imap_messages_account_folder` ON `imap_messages` (`account_id`,`folder`);--> statement-breakpoint
ALTER TABLE `sync_state` ADD `imap_backfilled` integer DEFAULT 0 NOT NULL;