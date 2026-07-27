// Run the daily health check immediately.
//
//   npm run health-check              # print the report, send nothing
//   npm run health-check -- --send    # also mail it, exactly as the daily job does
//
// On a Docker host:  docker exec -it <container> npm run health-check
import { db, schema, runMigrations } from '../db/index.js';
import { config } from '../config.js';
import {
  runHealthCheck,
  sendHealthReport,
  renderHealthReportText,
} from '../observability/healthcheck.js';

runMigrations();

const send = process.argv.includes('--send');
const orgs = db.select().from(schema.orgs).all();

let exitCode = 0;
for (const [i, org] of orgs.entries()) {
  const report = await runHealthCheck(org, i === 0);
  if (!report.accountsChecked && orgs.length > 1) continue;
  console.log('='.repeat(72));
  console.log(renderHealthReportText(report));
  console.log('');
  if (report.findings.some((f) => f.severity === 'critical')) exitCode = 1;
  if (send) {
    const outcome = await sendHealthReport(report);
    console.log(
      `report ${outcome}${outcome === 'skipped' ? ' (nothing wrong; set HEALTH_REPORT_ALWAYS=true to send anyway)' : ''}\n`,
    );
  }
}

if (!send) {
  console.log(
    `Nothing was emailed. Add --send to deliver, or wait for the daily run at ${String(
      config.HEALTH_REPORT_HOUR,
    ).padStart(2, '0')}:00 UTC.`,
  );
}
process.exit(exitCode);
