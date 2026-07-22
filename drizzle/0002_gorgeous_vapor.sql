-- Old rows hold bcrypt hashes which cannot be converted to the new
-- encrypted-at-rest scheme; they are removed (regenerate credentials).
DELETE FROM `smtp_credentials`;--> statement-breakpoint
ALTER TABLE `smtp_credentials` ADD `password_enc` text NOT NULL DEFAULT '';--> statement-breakpoint
ALTER TABLE `smtp_credentials` DROP COLUMN `password_hash`;
