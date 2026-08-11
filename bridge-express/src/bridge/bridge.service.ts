// TBP-341 — BridgeService: unified backend surface for Express.
//
// Server-side counterpart of the bridge-svelte `bridge` object. The two big
// differences vs the frontend surface:
//
//   1. NO channel. Pull mode: each `.snapshot()` call fetches via REST and
//      is cached via BridgePullCache (TTL configurable; defaults to 30s).
//      Live updates aren't a thing on the server — use Bridge webhooks for
//      event-driven server reactions (out of scope for this milestone).
//
//   2. NO singleton tenant. Every request has a different tenant context;
//      the SDK takes the incoming user JWT and returns a TenantScope whose
//      slices answer for THAT user's tenant.
//
// Typical usage from an Express handler:
//
//   const bridge = createBridge({ appId, ... });
//
//   app.get('/me', bridge.protect(), async (req, res) => {
//     const tenant = bridge.fromJwt(req.bridgeAccessToken!);
//     if (!(await tenant.entitlements.can('export'))) {
//       return res.status(403).end();
//     }
//     res.json(await tenant.subscription);
//   });
//
// `bridge.tenant(tenantId)` for arbitrary tenants (cron/admin paths) is not
// yet wired — bridge-api doesn't expose a tenant-by-id snapshot endpoint that
// accepts the workspace API key. Tracked as a follow-up; calling it throws
// a clear `Error` with the migration pointer.

import { BridgePullCache } from '@nebulr-group/bridge-auth-core';
import { getTenantId, getTenantUserId } from '@nebulr-group/bridge-auth-core/backend';

import { TenantScope } from './tenant-scope';

function decodeJwtSub(jwt: string): string {
  // Best-effort: build a stable cache key from the JWT's tenant/user claims.
  // We don't verify the signature here — that's the bridge-api's job at the
  // receiving end. The cache key only needs to be stable per JWT.
  const tid = getTenantId(jwt);
  const sub = getTenantUserId(jwt);
  if (tid) return `${tid}:${sub ?? ''}`;
  return sub ?? jwt;
}

export class BridgeService {
  constructor(
    private readonly apiBaseUrl: string,
    private readonly appId: string,
    private readonly cache: BridgePullCache,
  ) {}

  /**
   * Return a TenantScope for the tenant associated with `userJwt`. The JWT
   * is forwarded to bridge-api on the snapshot fetch — the API derives the
   * tenant from the token (req.bridgeTenant) and returns the matching
   * snapshot. Caching is keyed on the JWT's `tid:sub` claim so two
   * concurrent requests for the same user share one round-trip.
   */
  fromJwt(userJwt: string): TenantScope {
    const cacheKey = decodeJwtSub(userJwt);
    return new TenantScope(userJwt, cacheKey, this.cache, this.apiBaseUrl, this.appId);
  }

  /**
   * Reserved — arbitrary-tenant accessor for cron / admin paths. Not yet
   * wired: bridge-api doesn't expose a tenant-by-id snapshot endpoint that
   * accepts the workspace API key. Use `fromJwt(userJwt)` for the
   * request-scoped path.
   */
  tenant(_tenantId: string): never {
    throw new Error(
      '[bridge-express] `bridge.tenant(tenantId)` requires a bridge-api admin snapshot endpoint that accepts the workspace API key — not yet implemented. Use `bridge.fromJwt(userJwt)` from your request handler instead.',
    );
  }
}
