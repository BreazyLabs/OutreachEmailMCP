// Usage: npm run create-api-key -- [name]
import { nanoid } from 'nanoid';
import { db, schema, runMigrations } from '../db/index.js';
import { generateApiKey } from '../crypto/credentials.js';

runMigrations();
const name = process.argv[2] ?? 'cli';
const { key, prefix, hash } = generateApiKey();
db.insert(schema.apiKeys)
  .values({ id: nanoid(), name, keyPrefix: prefix, keyHash: hash, createdAt: Date.now() })
  .run();
console.log(`API key "${name}" created (shown once):\n\n  ${key}\n`);
console.log('Use it as:  Authorization: Bearer <key>');
