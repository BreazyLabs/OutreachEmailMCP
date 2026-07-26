// Admin tool for changing a workspace's plan without Stripe — e.g. granting
// the pro tier to your own workspace on a running instance.
//
// Usage:
//   npm run set-plan -- --list
//   npm run set-plan -- --email you@example.com --plan pro
//   npm run set-plan -- --org <orgId> --plan free
//
// On a Docker host:  docker exec -it <container> npm run set-plan -- --list
import { eq } from 'drizzle-orm';
import { db, schema, runMigrations } from '../db/index.js';
import { config } from '../config.js';
import { countAccounts, planLimits } from '../tenancy/orgs.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

runMigrations();

const list = process.argv.includes('--list');
const email = arg('email')?.toLowerCase();
const orgArg = arg('org');
const plan = arg('plan');

function describe(org: typeof schema.orgs.$inferSelect): string {
  const limits = planLimits(org);
  const owners = db
    .select({ email: schema.users.email })
    .from(schema.users)
    .where(eq(schema.users.orgId, org.id))
    .all()
    .map((u) => u.email)
    .join(', ');
  return [
    `  ${org.id}  ${org.name}`,
    `    plan=${org.plan} status=${org.status}`,
    `    mailboxes=${countAccounts(org.id)}/${limits.maxAccounts} sends/24h=${limits.dailySends}`,
    `    users=${owners || '(none)'}`,
  ].join('\n');
}

if (list || (!email && !orgArg)) {
  const orgs = db.select().from(schema.orgs).all();
  console.log(`Workspaces (SAAS_MODE=${config.SAAS_MODE}):\n`);
  for (const org of orgs) console.log(describe(org) + '\n');
  if (!config.SAAS_MODE) {
    console.log('Note: SAAS_MODE is off, so plan limits are not enforced — everything is unlimited.');
  }
  if (!list) console.log('Pass --email <owner> --plan pro (or --org <id>) to change a plan.');
  process.exit(0);
}

if (plan !== 'free' && plan !== 'pro') {
  console.error('--plan must be "free" or "pro"');
  process.exit(1);
}

const org = orgArg
  ? db.select().from(schema.orgs).where(eq(schema.orgs.id, orgArg)).get()
  : db
      .select({ org: schema.orgs })
      .from(schema.users)
      .innerJoin(schema.orgs, eq(schema.orgs.id, schema.users.orgId))
      .where(eq(schema.users.email, email!))
      .get()?.org;

if (!org) {
  console.error(`No workspace found for ${orgArg ?? email}. Run with --list to see them all.`);
  process.exit(1);
}

db.update(schema.orgs)
  .set({ plan, status: 'active' })
  .where(eq(schema.orgs.id, org.id))
  .run();

const updated = db.select().from(schema.orgs).where(eq(schema.orgs.id, org.id)).get()!;
console.log(`Updated workspace:\n\n${describe(updated)}\n`);
if (updated.stripeSubscriptionId) {
  console.log(
    'Heads-up: this workspace has a Stripe subscription. If it is later cancelled,\n' +
      'the webhook will set the plan back to free.',
  );
}
