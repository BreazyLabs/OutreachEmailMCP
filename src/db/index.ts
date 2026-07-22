import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import * as schema from './schema.js';

const dbPath = path.join(config.dataDir, 'emailproxy.db');

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });

const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../drizzle',
);

// The 0005 migration seeds the default org itself, so FK integrity holds for
// CLI tools and tests; runtime user seeding lives in tenancy/orgs.seedTenancy.
export function runMigrations() {
  migrate(db, { migrationsFolder });
}

export { schema };
