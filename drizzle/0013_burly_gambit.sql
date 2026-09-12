CREATE TABLE `domain_health` (
	`domain` text PRIMARY KEY NOT NULL,
	`checked_at` integer NOT NULL,
	`spf` text,
	`spf_ok` integer DEFAULT 0 NOT NULL,
	`dmarc` text,
	`dmarc_policy` text,
	`dmarc_ok` integer DEFAULT 0 NOT NULL,
	`dkim_selectors_json` text,
	`dkim_ok` integer DEFAULT 0 NOT NULL,
	`mx_json` text,
	`mx_ok` integer DEFAULT 0 NOT NULL,
	`issues_json` text,
	`error` text
);
--> statement-breakpoint
ALTER TABLE `orgs` ADD `warmup_tag_enabled` integer DEFAULT 0 NOT NULL;