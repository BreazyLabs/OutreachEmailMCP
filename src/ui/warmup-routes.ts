/**
 * Dashboard routes for warmup: the pool page with search/filter/bulk
 * actions, workspace defaults, and the per-mailbox controls used by the
 * account page.
 */

import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ZodError } from 'zod';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { guard, guardPost, baseLocals } from './helpers.js';
import {
  WARMUP_FIELDS,
  INSTANCE_DEFAULTS,
  parsePatch,
  patchFromForm,
  diffAgainstBaseline,
  resolveWarmupSettings,
  type WarmupSettingsPatch,
} from '../warmup/settings.js';
import { orgWarmupOverview } from '../warmup/stats.js';
import { applyAccountSettings, applyOrgSettings, clearAccountOverrides, runBulk } from '../warmup/api.js';
import { enableWarmup, disableWarmup, pauseWarmup, resumeWarmup, setPersona } from '../warmup/state.js';
import { llmStatus } from '../warmup/content/llm.js';
import { healthOf, orgHealth, HEALTH_LABELS } from '../warmup/health.js';
import { placementChartSvg, sparklineSvg, CHART_LEGEND } from './charts.js';
import { logActivity } from '../observability/activity.js';

type Body = Record<string, unknown>;

const toList = (v: unknown): string[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v.map(String) : [String(v)];

/** Bulk form → patch: blank = unchanged, "clear" checkbox = inherit. */
function patchFromBulkForm(body: Body): WarmupSettingsPatch {
  const patch = patchFromForm(body) as Record<string, unknown>;
  for (const field of WARMUP_FIELDS) {
    if (body[`clear_${field.key}`]) patch[field.key] = null;
  }
  return patch as WarmupSettingsPatch;
}

/** Pre-filled form → patch: every field is present, so a blank is a
 *  deliberate "inherit", and anything equal to the layer above is not
 *  stored as an override. */
function patchFromPrefilledForm(body: Body, baseline: typeof INSTANCE_DEFAULTS): WarmupSettingsPatch {
  const patch = patchFromForm(body) as Record<string, unknown>;
  for (const field of WARMUP_FIELDS) {
    if (body[field.key] === '') patch[field.key] = null;
  }
  return diffAgainstBaseline(patch as WarmupSettingsPatch, baseline);
}

function errorText(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  }
  return err instanceof Error ? err.message : String(err);
}

function ownedAccount(accountId: string, orgId: string) {
  return db
    .select()
    .from(schema.accounts)
    .where(and(eq(schema.accounts.id, accountId), eq(schema.accounts.orgId, orgId)))
    .get();
}

export function registerWarmupUiRoutes(app: FastifyInstance): void {
  app.get('/ui/warmup', async (req, reply) => {
    const session = guard(req, reply);
    if (!session) return;
    const overview = orgWarmupOverview(session.org);
    const health = Object.fromEntries(overview.accounts.map((a) => [a.accountId, healthOf(a)]));
    const sparks = Object.fromEntries(
      overview.accounts.map((a) => [a.accountId, a.enabled ? sparklineSvg(overview.sparks[a.accountId] ?? []) : '']),
    );
    const domains = [...new Set(overview.accounts.map((a) => a.email.split('@')[1] ?? ''))].sort();
    return reply.view('warmup.ejs', {
      ...baseLocals(req, session),
      page: 'warmup',
      overview,
      health,
      orgHealth: orgHealth(overview.accounts),
      healthLabels: HEALTH_LABELS,
      sparks,
      domains,
      chart: placementChartSvg(overview.daily, 30),
      chartLegend: CHART_LEGEND,
      fields: WARMUP_FIELDS,
      instanceDefaults: INSTANCE_DEFAULTS,
      orgValues: parsePatch(session.org.warmupDefaultsJson),
      orgResolved: resolveWarmupSettings(session.org, null).settings,
      engineEnabled: config.WARMUP_ENABLED,
      llm: llmStatus(),
      llmModel: config.WARMUP_LLM_MODEL,
      instanceCap: config.WARMUP_MAX_DAILY_PER_ACCOUNT,
    });
  });

  app.post<{ Body: Body }>('/ui/warmup/bulk', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const body = req.body ?? {};
    const accountIds = toList(body.accountIds);
    if (accountIds.length === 0) {
      return reply.redirect('/ui/warmup?error=' + encodeURIComponent('Select at least one mailbox first.'));
    }
    const action = String(body.action ?? '');
    try {
      const settings = action === 'settings' ? (patchFromBulkForm(body) as Record<string, unknown>) : undefined;
      if (action === 'settings' && (!settings || Object.keys(settings).length === 0)) {
        return reply.redirect('/ui/warmup?error=' + encodeURIComponent('Fill in at least one setting to apply.'));
      }
      const { results } = runBulk(session.org.id, {
        accountIds,
        action: action === 'settings' ? undefined : (action as 'enable' | 'disable' | 'pause' | 'resume' | 'clear_overrides'),
        settings,
      });
      const failed = results.filter((r) => !r.ok);
      const verb =
        action === 'enable' ? 'enabled' : action === 'disable' ? 'disabled' : action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : 'updated';
      const notice = failed.length
        ? `${results.length - failed.length} ${verb}, ${failed.length} failed: ${failed[0]?.error ?? ''}`
        : `${results.length} mailbox${results.length === 1 ? '' : 'es'} ${verb}.${action === 'enable' ? ' Today is planned within a minute.' : ''}`;
      return reply.redirect('/ui/warmup?notice=' + encodeURIComponent(notice));
    } catch (err) {
      return reply.redirect('/ui/warmup?error=' + encodeURIComponent(errorText(err)));
    }
  });

  app.post<{ Body: Body }>('/ui/warmup/defaults', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    const body = req.body ?? {};
    try {
      const defaults = patchFromPrefilledForm(body, INSTANCE_DEFAULTS) as Record<string, unknown>;
      const filterTag = String(body.filterTag ?? '').trim();
      applyOrgSettings(session.org.id, {
        defaults,
        poolScope: body.poolScope === 'org' ? 'org' : body.poolScope === 'instance' ? 'instance' : undefined,
        filterTag: filterTag && filterTag !== session.org.warmupFilterTag ? filterTag : undefined,
        emitWebhooks: body._settingsForm ? Boolean(body.emitWebhooks) : undefined,
        showInSendLog: body._settingsForm ? Boolean(body.showInSendLog) : undefined,
      });
      return reply.redirect('/ui/warmup?notice=' + encodeURIComponent('Workspace warmup defaults saved.'));
    } catch (err) {
      return reply.redirect('/ui/warmup?error=' + encodeURIComponent(errorText(err)));
    }
  });

  app.post('/ui/warmup/defaults/reset', async (req, reply) => {
    const session = guardPost(req, reply);
    if (!session) return;
    db.update(schema.orgs).set({ warmupDefaultsJson: null }).where(eq(schema.orgs.id, session.org.id)).run();
    logActivity({ category: 'warmup', action: 'org-settings', status: 'ok', orgId: session.org.id, detail: 'reset to instance defaults' });
    return reply.redirect('/ui/warmup?notice=' + encodeURIComponent('Workspace defaults reset to the instance defaults.'));
  });

  app.post<{ Params: { accountId: string; action: string } }>(
    '/ui/accounts/:accountId/warmup/:action',
    async (req, reply) => {
      const session = guardPost(req, reply);
      if (!session) return;
      const account = ownedAccount(req.params.accountId, session.org.id);
      if (!account) return reply.code(404).send('Unknown account');
      const back = `/ui/accounts/${account.id}`;
      const body = (req.body ?? {}) as Body;
      try {
        switch (req.params.action) {
          case 'enable':
            enableWarmup(account.id);
            return reply.redirect(`${back}?notice=` + encodeURIComponent('Warmup enabled. Today is planned within a minute.'));
          case 'disable':
            disableWarmup(account.id);
            return reply.redirect(`${back}?notice=` + encodeURIComponent('Warmup disabled.'));
          case 'pause':
            pauseWarmup(account.id, 'Paused from the dashboard');
            return reply.redirect(`${back}?notice=` + encodeURIComponent('Warmup paused. Received mail is still engaged with; no new conversations start.'));
          case 'resume':
            resumeWarmup(account.id);
            return reply.redirect(`${back}?notice=` + encodeURIComponent('Warmup resumed.'));
          case 'settings': {
            const baseline = resolveWarmupSettings(session.org, null).settings;
            const patch = patchFromPrefilledForm(body, baseline) as Record<string, unknown>;
            applyAccountSettings(account.id, patch);
            return reply.redirect(`${back}?notice=` + encodeURIComponent('Warmup settings saved for this mailbox.'));
          }
          case 'reset':
            clearAccountOverrides(account.id);
            return reply.redirect(`${back}?notice=` + encodeURIComponent('Mailbox overrides cleared; workspace defaults apply.'));
          case 'persona':
            setPersona(account.id, {
              firstName: String(body.firstName ?? '').trim() || undefined,
              lastName: String(body.lastName ?? '').trim() || null,
              role: String(body.role ?? '').trim() || null,
              company: String(body.company ?? '').trim() || null,
              signOff: String(body.signOff ?? '').trim() || null,
            });
            return reply.redirect(`${back}?notice=` + encodeURIComponent('Persona saved.'));
          default:
            return reply.code(404).send('Unknown action');
        }
      } catch (err) {
        return reply.redirect(`${back}?error=` + encodeURIComponent(errorText(err)));
      }
    },
  );
}
