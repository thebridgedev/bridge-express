// TBP-341 — Tenant-scoped view onto the unified bridge surface.
//
// One TenantScope per incoming request (or per arbitrary tenantId for cron /
// admin paths once that path lands). All slices share one cached snapshot
// fetch — `GET /session/init` returns subscription + entitlements + branding
// + user in a single round-trip, and BridgePullCache dedups concurrent calls.

import { BridgePullCache } from '@nebulr-group/bridge-auth-core';

export interface BrandingSnapshot {
  logo: string;
  name: string;
  primaryButtonBgColor?: string;
  textColor?: string;
  bgColor?: string;
  fontFamily?: string;
}

export interface SubscriptionSnapshot {
  plan: { slug: string; name: string };
  status: string;
  endsAt?: string;
  gateEngaged?: boolean;
}

export interface UserSnapshot {
  id: string;
  email?: string;
  role: string;
  tenantId: string;
}

export interface SessionSnapshotData {
  app: { branding: BrandingSnapshot };
  tenant: {
    id: string;
    name: string;
    subscription: SubscriptionSnapshot;
    entitlements: Record<string, boolean>;
  };
  user: UserSnapshot;
}

export interface TenantEntitlementsView {
  /** Synchronous check after the snapshot is loaded. Caller must `await tenant.snapshot` first. */
  canSync(key: string, cached: Record<string, boolean> | undefined): boolean;
  /** Loads the snapshot if needed, then answers the entitlement check. */
  can(key: string): Promise<boolean>;
  /** The full entitlements map; fetches the snapshot on first call. */
  snapshot(): Promise<Record<string, boolean>>;
}

export class TenantScope {
  constructor(
    private readonly userJwt: string,
    private readonly cacheKey: string,
    private readonly cache: BridgePullCache,
    private readonly apiBaseUrl: string,
    private readonly appId: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  /**
   * Load the session.snapshot payload for this tenant. Cached via
   * `BridgePullCache`; concurrent callers share the in-flight fetch.
   */
  snapshot(): Promise<SessionSnapshotData> {
    return this.cache.get(`session:${this.cacheKey}`, () => this._fetchSnapshot());
  }

  /** Lazy: the subscription slice of the session snapshot. */
  get subscription(): Promise<SubscriptionSnapshot> {
    return this.snapshot().then((s) => s.tenant.subscription);
  }

  /** Lazy: app branding (logo, colors, name). */
  get branding(): Promise<BrandingSnapshot> {
    return this.snapshot().then((s) => s.app.branding);
  }

  /** Lazy: the user snapshot for the JWT subject (id/email/role/tenantId). */
  get user(): Promise<UserSnapshot> {
    return this.snapshot().then((s) => s.user);
  }

  /** Lazy: the entitlements map; `.can(key)` is the common path. */
  get entitlements(): TenantEntitlementsView {
    const snap = (): Promise<Record<string, boolean>> =>
      this.snapshot().then((s) => s.tenant.entitlements);
    return {
      canSync: (key, cached) => !!cached?.[key],
      can: async (key) => {
        const m = await snap();
        return !!m[key];
      },
      snapshot: snap,
    };
  }

  /** Force-refresh the cached snapshot on the next access (post-mutation). */
  invalidate(): void {
    this.cache.invalidate(`session:${this.cacheKey}`);
  }

  private async _fetchSnapshot(): Promise<SessionSnapshotData> {
    const url = `${this.apiBaseUrl.replace(/\/+$/, '')}/session/init`;
    const res = await this.fetcher(url, {
      headers: {
        Authorization: `Bearer ${this.userJwt}`,
        'x-app-id': this.appId,
      },
    });
    if (!res.ok) {
      throw new Error(`[bridge-express] GET /session/init failed: ${res.status}`);
    }
    return (await res.json()) as SessionSnapshotData;
  }
}
