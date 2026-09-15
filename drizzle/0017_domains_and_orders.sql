CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`domain` text NOT NULL,
	`registrar` text DEFAULT 'other' NOT NULL,
	`status` text DEFAULT 'purchased' NOT NULL,
	`purchased_at` integer,
	`expires_at` integer,
	`registrar_json` text,
	`order_id` text,
	`tags_json` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `domains_org_domain` ON `domains` (`org_id`,`domain`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`config_enc` text NOT NULL,
	`verified_at` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_org_provider` ON `integrations` (`org_id`,`provider`);--> statement-breakpoint
CREATE TABLE `provider_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`provider` text NOT NULL,
	`external_id` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`email_provider` text NOT NULL,
	`domains_json` text NOT NULL,
	`request_json` text NOT NULL,
	`result_enc` text,
	`last_error` text,
	`last_checked_at` integer,
	`delivered_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE cascade
);
