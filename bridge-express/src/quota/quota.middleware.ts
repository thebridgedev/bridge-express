// TBP-745 — `bridge.requireQuota`, `bridge.syncQuota` and
// `bridge.requireEntitlement`: the express twins of bridge-nestjs
// `@RequireQuota` / `@SyncQuota` / `@RequireEntitlement` (TBP-704).
//
// Put them after `bridge.auth()` / `bridge.protect()` — they need the user
// token that middleware verified.
//
// Before the handler: entitlement (403), then quota (402), both answered as
// JSON without calling the handler.
// After the handler: only when it answered 2xx — one write to Bridge per
// metric, made when the handler ends the response and before the response
// is released, so a client that re-reads its usage right after the 2xx sees
// the new count (the same order as the NestJS interceptor). A handler that
// throws, or answers 4xx/5xx, records nothing.

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { TenantScope } from '../bridge/tenant-scope';
import { verifiedUserTokenFor } from '../bridge/verified-request';
import { BridgeQuotaService, BridgeRefusalError, type QuotaCount } from './quota.service';

/** The tenant a `current` count is asked about. From the verified token only. */
export interface QuotaTenant {
  /** Verified tenant (workspace) id. */
  id: string;
  /** Verified user id. */
  userId: string;
  /** The full tenant view — subscription, entitlements, usage. */
  scope: TenantScope;
  /** The incoming request. */
  request: Request;
}

/**
 * Counts how many exist right now for this tenant. Gets the request as its
 * second argument:
 *
 *   current: (t) => db.tickets.count({ tenantId: t.id })
 */
export type QuotaCounter = (tenant: QuotaTenant, req: Request) => number | Promise<number>;

export interface RequireQuotaOptions {
  /**
   * Gauge mode — for things that exist and free room when deleted. Return
   * your own count; the request is refused when it is already at the limit,
   * and after a 2xx the gauge is set to the new count.
   *
   * Leave out for a counter — something that happened (an export, an API
   * call): Bridge's tally is compared, and one event is reported after a 2xx,
   * deduplicated by the request's `Idempotency-Key` header.
   */
  current?: QuotaCounter;
}

export interface SyncQuotaOptions {
  /** Your count after the handler ran; the gauge is set to it after a 2xx. */
  current: QuotaCounter;
}

/**
 * TBP-697 — outside production, a response from an endpoint that counts a
 * metric says so, so the browser plugin can warn in development when the page
 * ALSO reports that metric with `bridge.usage` (the same action counted
 * twice). Never sent when `NODE_ENV=production`.
 */
export const USAGE_COUNTED_HEADER = 'X-Bridge-Usage-Counted';

/** Per request: which middleware already ran (a route may list one twice). */
const handled = new WeakMap<object, Set<string>>();
/** Per response: the writes to run once a 2xx is ended, and the gauges already written. */
const pending = new WeakMap<object, { tasks: Array<() => Promise<void>>; gauges: Set<string> }>();
/** Entitlement keys the TBP-705 development note was already logged for. */
const notedEntitlements = new Set<string>();

/**
 * TBP-705 — `requireEntitlement` is the documented exception to "every gate
 * is a flag". Outside production, say so once per key, the first time a
 * request reaches it.
 */
export function noteDirectEntitlementCheck(key: string): void {
  if (process.env.NODE_ENV === 'production' || notedEntitlements.has(key)) return;
  notedEntitlements.add(key);
  console.warn(
    `[bridge] bridge.requireEntitlement('${key}') checks the plan directly. The standard is bridge.protect({ featureFlag }) with a rule on bridge:billing.entitlement.${key} — see "npx @nebulr-group/bridge-cli check gates".`,
  );
}

/** Test hook: forget which keys were noted. */
export function resetEntitlementNotes(): void {
  notedEntitlements.clear();
}

export function createRequireQuotaMiddleware(
  quota: BridgeQuotaService,
  metric: string,
  opts: RequireQuotaOptions = {},
): RequestHandler {
  assertMetric(metric, 'requireQuota');
  if (opts.current !== undefined && typeof opts.current !== 'function') {
    throw new TypeError(`[bridge-express] bridge.requireQuota('${metric}') — \`current\` must be a count function`);
  }
  const current = opts.current;
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (once(req, `quota:${metric}`)) return next();
    let recordCounter: boolean;
    try {
      let decision;
      try {
        decision = await quota.assertQuota(req, metric, { current: counter(quota, current, req) });
      } catch (error) {
        // TBP-697 — this endpoint is where the metric is counted; a 402
        // refusal carries the header too.
        markCounted(res, [metric]);
        throw error;
      }
      // A gauge nobody counts here (e.g. seats, which Bridge keeps from
      // membership) is checked but never reported as a counter event.
      recordCounter = !current && decision.quota?.kind !== 'gauge';
      const checkedOnly = !current && !recordCounter;
      if (!checkedOnly) markCounted(res, [metric]);
    } catch (error) {
      return refuse(res, next, error);
    }

    if (current) {
      afterSuccess(res, (state) =>
        writeGaugeOnce(state.gauges, metric, () => quota.sync(req, metric, counter(quota, current, req)!)),
      );
    } else if (recordCounter) {
      afterSuccess(res, () => quota.record(req, metric, { idempotencyKey: idempotencyHeader(req) }));
    }
    next();
  };
}

export function createSyncQuotaMiddleware(
  quota: BridgeQuotaService,
  metric: string,
  opts: SyncQuotaOptions,
): RequestHandler {
  assertMetric(metric, 'syncQuota');
  if (typeof opts?.current !== 'function') {
    throw new TypeError(`[bridge-express] bridge.syncQuota('${metric}') needs a \`current\` count function`);
  }
  const current = opts.current;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (once(req, `sync:${metric}`)) return next();
    markCounted(res, [metric]);
    afterSuccess(res, (state) =>
      writeGaugeOnce(state.gauges, metric, () => quota.sync(req, metric, counter(quota, current, req)!)),
    );
    next();
  };
}

export function createRequireEntitlementMiddleware(
  quota: BridgeQuotaService,
  key: string,
): RequestHandler {
  if (typeof key !== 'string' || key.length === 0) {
    throw new TypeError('[bridge-express] bridge.requireEntitlement needs an entitlement key');
  }
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (once(req, `entitlement:${key}`)) return next();
    noteDirectEntitlementCheck(key);
    try {
      await quota.assertEntitlement(req, key);
    } catch (error) {
      return refuse(res, next, error);
    }
    next();
  };
}

// ── helpers ────────────────────────────────────────────────────────────────

function assertMetric(metric: string, name: string): void {
  if (typeof metric !== 'string' || metric.length === 0) {
    throw new TypeError(`[bridge-express] bridge.${name}() needs a metric name`);
  }
}

/** True when this middleware already ran for this request. */
function once(req: object, id: string): boolean {
  let seen = handled.get(req);
  if (!seen) handled.set(req, (seen = new Set()));
  if (seen.has(id)) return true;
  seen.add(id);
  return false;
}

/** Write a refusal as JSON; anything else goes to the app's error handler. */
function refuse(res: Response, next: NextFunction, error: unknown): void {
  if (error instanceof BridgeRefusalError) {
    res.status(error.status).json(error.body);
    return;
  }
  next(error);
}

/** The count function bound to this tenant and request. */
function counter(
  quota: BridgeQuotaService,
  current: QuotaCounter | undefined,
  req: Request,
): QuotaCount | undefined {
  if (!current) return undefined;
  return () => current(quotaTenant(quota, req), req);
}

function quotaTenant(quota: BridgeQuotaService, req: Request): QuotaTenant {
  return {
    id: quota.tenantIdFor(req),
    userId: verifiedUserTokenFor(req)?.claims.sub ?? '',
    scope: quota.tenantFor(req),
    request: req,
  };
}

/** One gauge write per metric per request, whichever middleware gets there first. */
async function writeGaugeOnce(gauges: Set<string>, metric: string, write: () => Promise<void>): Promise<void> {
  if (gauges.has(metric)) return;
  gauges.add(metric);
  await write();
}

/**
 * Run `task` when the handler ends a 2xx response, before the response is
 * released. The status is final once `res.end()` is called, so a 4xx/5xx
 * (including Express's own error handler answering a thrown handler) runs
 * nothing. A task never fails the response.
 */
function afterSuccess(
  res: Response,
  task: (state: { gauges: Set<string> }) => Promise<void>,
): void {
  let state = pending.get(res);
  if (!state) {
    const created = { tasks: [] as Array<() => Promise<void>>, gauges: new Set<string>() };
    state = created;
    pending.set(res, created);
    const end = res.end;
    let ended = false;
    (res as { end: unknown }).end = function patchedEnd(this: Response, ...args: unknown[]) {
      if (ended) return this;
      ended = true;
      const status = res.statusCode;
      if (status < 200 || status >= 300 || created.tasks.length === 0) {
        return (end as (...a: unknown[]) => Response).apply(res, args);
      }
      const tasks = created.tasks.splice(0);
      void Promise.all(tasks.map((t) => t().catch(() => undefined))).then(() => {
        (end as (...a: unknown[]) => Response).apply(res, args);
      });
      return res;
    } as Response['end'];
  }
  const s = state;
  s.tasks.push(() => task(s));
}

/**
 * TBP-697 — name the metrics this endpoint counts on the response, outside
 * production only. Also exposed to cross-origin pages (`fetch` cannot read a
 * custom header otherwise). Best effort: never fails the request.
 */
function markCounted(res: Response, metrics: string[]): void {
  if (metrics.length === 0 || process.env.NODE_ENV === 'production' || res.headersSent) return;
  try {
    const current = (name: string): string => {
      const raw = res.getHeader(name);
      return Array.isArray(raw) ? raw.join(', ') : typeof raw === 'string' ? raw : '';
    };
    const merge = (existing: string, add: string[]) =>
      [...new Set([...existing.split(',').map((v) => v.trim()).filter(Boolean), ...add])].join(', ');
    res.setHeader(USAGE_COUNTED_HEADER, merge(current(USAGE_COUNTED_HEADER), [...new Set(metrics)]));
    res.setHeader(
      'Access-Control-Expose-Headers',
      merge(current('Access-Control-Expose-Headers'), [USAGE_COUNTED_HEADER]),
    );
  } catch {
    /* a dev hint must never break the request */
  }
}

function idempotencyHeader(req: Request): string | undefined {
  const raw = req.headers?.['idempotency-key'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
