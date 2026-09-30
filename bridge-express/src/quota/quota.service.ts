// TBP-745 — plan limits and entitlements as plain calls (the express twin of
// bridge-nestjs `BridgeQuotaService`, TBP-704).
//
// Everything `bridge.requireQuota`, `bridge.syncQuota` and
// `bridge.requireEntitlement` do is a call on this service, so a developer
// who wants control (a worker, a bulk endpoint, a check in the middle of a
// handler) calls the same code the middleware runs.
//
// The model (owner-agreed, TBP-M35):
//   - the server is authoritative, the client is decorative;
//   - a counter is something that happened (exports, API calls) — Bridge
//     counts it from reported events;
//   - a gauge is something that exists and frees room when deleted (tickets,
//     projects) — the app counts it and sends Bridge the whole current count
//     after every create and delete. No decrement, so it heals itself;
//   - no reservation: check before, record after a success;
//   - a `metered` quota never refuses, it bills.
//
// Identity only ever comes from the token `bridge.auth()` / `bridge.protect()`
// verified on this request (`BridgeService.fromRequest`) — never a header,
// never a raw token (TBP-673, TBP-671).

import { createHash } from 'crypto';

import type { BridgeService } from '../bridge/bridge.service';
import type { QuotaSnapshot, TenantScope } from '../bridge/tenant-scope';
import { verifiedUserTokenFor } from '../bridge/verified-request';
import type { BridgeConfigService } from '../services/bridge-config.service';

/** Body of the 402 a request at its plan limit is refused with. */
export interface QuotaExceededBody {
  statusCode: 402;
  code: 'QUOTA_EXCEEDED';
  message: string;
  metric: string;
  used: number;
  limit: number;
  /** Where to upgrade — `billing.manageRoute`, default `/subscription`. */
  fix: string;
}

/** Body of the 403 a request without the entitlement is refused with. */
export interface EntitlementRequiredBody {
  statusCode: 403;
  code: 'ENTITLEMENT_REQUIRED';
  message: string;
  entitlement: string;
  fix: string;
}

/**
 * A refusal the quota calls raise: `status` and the JSON `body` to answer
 * with. The middleware writes it for you; from your own code,
 * `res.status(err.status).json(err.body)`.
 */
export class BridgeRefusalError<B extends object = Record<string, unknown>> extends Error {
  constructor(
    public readonly status: number,
    public readonly body: B,
  ) {
    super(String((body as { message?: unknown }).message ?? `Bridge refused the request (${status})`));
    this.name = 'BridgeRefusalError';
  }
}

/** 402 `QUOTA_EXCEEDED`. */
export class QuotaExceededError extends BridgeRefusalError<QuotaExceededBody> {
  constructor(body: QuotaExceededBody) {
    super(402, body);
    this.name = 'QuotaExceededError';
  }
}

/** 403 `ENTITLEMENT_REQUIRED`. */
export class EntitlementRequiredError extends BridgeRefusalError<EntitlementRequiredBody> {
  constructor(body: EntitlementRequiredBody) {
    super(403, body);
    this.name = 'EntitlementRequiredError';
  }
}

/** A gauge's current count: a number, or a function that counts. */
export type QuotaCount = number | (() => number | Promise<number>);

export interface QuotaCheckOptions {
  /**
   * Gauge mode: how many exist right now in this tenant (your own count).
   * The request is refused when this is already at the limit. Leave out for
   * a counter — Bridge's own tally of reported events is compared instead.
   */
  current?: QuotaCount;
}

export interface QuotaDecision {
  /** False only for a `hard` quota at or past its limit. */
  allowed: boolean;
  metric: string;
  /** The count compared against the limit (your count in gauge mode). */
  used: number;
  /** `null` when the plan sets no quota for this metric (unlimited). */
  limit: number | null;
  /** The live snapshot, `null` when no quota is configured. */
  quota: QuotaSnapshot | null;
}

export interface QuotaRecordOptions {
  /** Gauge mode: the count after the change. Sets the gauge to it. */
  current?: QuotaCount;
  /** Counter mode: units to report. @default 1 */
  value?: number;
  /**
   * Counter mode: the client's idempotency key (typically its
   * `Idempotency-Key` header). The same key for the same tenant and metric
   * records one event however often the request is retried. Leave out to
   * let every call count.
   */
  idempotencyKey?: string;
}

export class BridgeQuotaService {
  /** Metrics already warned about (gauge quota without a count), per process. */
  private readonly warned = new Set<string>();

  constructor(
    private readonly bridge: BridgeService,
    private readonly config: BridgeConfigService,
  ) {}

  /**
   * The tenant of the user the auth middleware verified on this request.
   * 401 when there is none: a quota or entitlement belongs to a workspace,
   * and a public route, an unguarded route or an API-token-only caller has no
   * verified workspace user.
   */
  tenantFor(req: unknown): TenantScope {
    if (!verifiedUserTokenFor(req)) {
      throw new BridgeRefusalError(401, {
        statusCode: 401,
        error: 'Unauthorized',
        message: 'A signed-in workspace user is required',
      });
    }
    return this.bridge.fromRequest(req);
  }

  /** The verified tenant id of this request's user ('' when the token has none). */
  tenantIdFor(req: unknown): string {
    const claims = verifiedUserTokenFor(req)?.claims;
    return claims?.tid ?? claims?.tenant_id ?? '';
  }

  /**
   * Decide whether one more `metric` fits the plan, without refusing.
   * A `metered` quota and a metric with no quota are always allowed.
   * Rejects with 503 when the quota cannot be read (fail closed).
   */
  async check(req: unknown, metric: string, opts: QuotaCheckOptions = {}): Promise<QuotaDecision> {
    const tenant = this.tenantFor(req);
    let quota: QuotaSnapshot | null;
    try {
      quota = await tenant.usage.quota(metric);
    } catch (error) {
      this.config.log('Quota could not be read — refusing (fail-closed)', { metric, error });
      throw new BridgeRefusalError(503, {
        statusCode: 503,
        code: 'QUOTA_UNAVAILABLE',
        message: `The '${metric}' quota could not be checked. Try again.`,
        metric,
      });
    }
    if (!quota) {
      return { allowed: true, metric, used: 0, limit: null, quota: null };
    }
    if (quota.policy !== 'hard') {
      // Metered: the limit is the included allowance, overage is billed.
      return { allowed: true, metric, used: quota.used, limit: quota.limit, quota };
    }
    const used =
      opts.current !== undefined ? await this.count(opts.current, metric) : this.counterUsed(quota);
    return { allowed: used < quota.limit, metric, used, limit: quota.limit, quota };
  }

  /**
   * Refuse with 402 `QUOTA_EXCEEDED` when one more `metric` does not fit a
   * `hard` quota. Resolves with the decision otherwise.
   */
  async assertQuota(req: unknown, metric: string, opts: QuotaCheckOptions = {}): Promise<QuotaDecision> {
    const decision = await this.check(req, metric, opts);
    if (!decision.allowed) {
      this.config.log('Quota check failed', { metric, used: decision.used, limit: decision.limit });
      throw new QuotaExceededError(this.quotaExceededBody(metric, decision.used, decision.limit!));
    }
    return decision;
  }

  /**
   * Record usage after a successful change — exactly one write to Bridge.
   * Gauge (`current` given): sets the gauge to the current count.
   * Counter: reports `value` (default 1) under the idempotency key.
   *
   * Never throws: the thing was already created or deleted, and failing the
   * response would invite a retry that creates it twice. A lost gauge write
   * is corrected by the next create or delete.
   */
  async record(req: unknown, metric: string, opts: QuotaRecordOptions = {}): Promise<void> {
    let tenant: TenantScope;
    try {
      tenant = this.tenantFor(req);
    } catch {
      this.config.log('Usage not recorded — no verified workspace user on this request', { metric });
      return;
    }
    if (opts.current !== undefined) {
      try {
        const value = await this.count(opts.current, metric);
        await tenant.usage.set(metric, value);
      } catch (error) {
        console.warn(`[bridge-express] could not set the '${metric}' gauge after the request`, error);
      }
      return;
    }
    const key =
      opts.idempotencyKey !== undefined
        ? this.idempotencyKeyFor(req, metric, opts.idempotencyKey)
        : undefined;
    await tenant.usage.report(metric, opts.value ?? 1, key);
  }

  /** Set a gauge to the current count — what `bridge.syncQuota` does. Never throws. */
  async sync(req: unknown, metric: string, current: QuotaCount): Promise<void> {
    await this.record(req, metric, { current });
  }

  /**
   * Refuse with 403 `ENTITLEMENT_REQUIRED` unless the tenant holds `key`.
   * 503 when entitlements cannot be read (fail closed).
   */
  async assertEntitlement(req: unknown, key: string): Promise<void> {
    const tenant = this.tenantFor(req);
    let granted: boolean;
    try {
      granted = await tenant.entitlements.can(key);
    } catch (error) {
      this.config.log('Entitlements could not be read — refusing (fail-closed)', { key, error });
      throw new BridgeRefusalError(503, {
        statusCode: 503,
        code: 'ENTITLEMENT_UNAVAILABLE',
        message: `The '${key}' entitlement could not be checked. Try again.`,
        entitlement: key,
      });
    }
    if (!granted) {
      this.config.log('Entitlement check failed', { key });
      throw new EntitlementRequiredError({
        statusCode: 403,
        code: 'ENTITLEMENT_REQUIRED',
        message: `Your plan does not include '${key}'.`,
        entitlement: key,
        fix: this.config.manageRoute,
      });
    }
  }

  quotaExceededBody(metric: string, used: number, limit: number): QuotaExceededBody {
    return {
      statusCode: 402,
      code: 'QUOTA_EXCEEDED',
      message: `Your plan allows ${limit} ${metric}; ${used} are in use.`,
      metric,
      used,
      limit,
      fix: this.config.manageRoute,
    };
  }

  /*
   * TBP-738 — the key sent to Bridge for a client-supplied idempotency key.
   * Bridge dedupes usage events on the key alone, across every workspace, so
   * the client's raw value is never sent: two tenants (or two metrics) that
   * happen to pick the same key would otherwise swallow each other's events,
   * and a caller could suppress another workspace's usage by guessing its
   * keys. Scoped to the VERIFIED tenant id and the metric, then hashed so the
   * length is bounded. The same key from the same tenant for the same metric
   * still maps to one event. Byte-for-byte the same as bridge-nestjs.
   */
  idempotencyKeyFor(req: unknown, metric: string, clientKey: string): string {
    const digest = createHash('sha256')
      .update(`${this.tenantIdFor(req)}\u0000${metric}\u0000${clientKey}`)
      .digest('hex');
    return `idem-${digest}`;
  }

  /** Counter mode on a hard quota. A gauge nobody counts falls back to Bridge's stored value; seats (source membership) are Bridge's own count. */
  private counterUsed(quota: QuotaSnapshot): number {
    if (quota.kind === 'gauge' && quota.source !== 'membership' && !this.warned.has(quota.metric)) {
      this.warned.add(quota.metric);
      console.warn(
        `[bridge-express] '${quota.metric}' is a gauge quota but no \`current\` count was given — comparing Bridge's last stored value. Pass \`current\` so the check uses your own count and the gauge stays in step.`,
      );
    }
    return quota.used;
  }

  private async count(current: QuotaCount, metric: string): Promise<number> {
    const value = typeof current === 'function' ? await current() : current;
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(
        `[bridge-express] the count for '${metric}' must be an integer >= 0, got ${String(value)}`,
      );
    }
    return value;
  }
}
