import { createHash } from 'crypto';
import { BridgeConfigService } from './bridge-config.service';
import { FeatureFlagRequirement } from '../types/config';
import { readExplanation, type FeatureOffExplanation, type FeatureOffReason } from '../flags/feature-refusal';

interface FlagEvaluation {
  flag: string;
  evaluation?: {
    enabled: boolean;
    reason?: string;
    feature?: string;
  };
}

/**
 * TBP-756 — a requirement's verdict with the reason. `flag` names the flag the
 * reason belongs to (for `{any}` / `{all}`, the deciding one).
 */
export interface RequirementVerdict {
  ok: boolean;
  flag?: string;
  explanation?: FeatureOffExplanation;
}

// How close a reason is to "an upgrade alone opens it".
const REASON_RANK: Record<FeatureOffReason, number> = { plan: 0, permission: 1, rule: 2, off: 3, rollout: 4 };

interface BulkEvaluateResponse {
  flags: FlagEvaluation[];
}

/**
 * Service for evaluating feature flags via the backendless API
 */
export class FeatureFlagService {
  private cache: Map<string, Map<string, boolean>> = new Map();
  /** TBP-756 — per token, why each off flag is off (as Bridge said). */
  private reasons: Map<string, Map<string, FeatureOffExplanation>> = new Map();
  private cacheTimestamps: Map<string, number> = new Map();
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(private readonly configService: BridgeConfigService) {}

  /**
   * Check if a single feature flag is enabled
   *
   * @param flag - The flag name to check
   * @param accessToken - The user's access token
   * @param forceLive - If true, bypasses cache and makes a live API call
   */
  async isEnabled(flag: string, accessToken: string, forceLive = false): Promise<boolean> {
    const cacheKey = this.getCacheKey(accessToken);
    const now = Date.now();

    // Check cache first (unless forceLive)
    if (!forceLive) {
      const cached = this.getCachedValue(cacheKey, flag, now);
      if (cached !== undefined) {
        this.configService.log(`Feature flag '${flag}' from cache: ${cached}`);
        return cached;
      }

      // Try bulk evaluate to populate cache
      await this.bulkEvaluate(accessToken);
      const afterBulk = this.getCachedValue(cacheKey, flag, now);
      if (afterBulk !== undefined) {
        return afterBulk;
      }
    }

    // Single flag evaluation (forceLive or flag not in bulk response)
    const result = await this.evaluateSingleFlag(flag, accessToken);

    // Update cache
    this.setCachedValue(cacheKey, flag, result, now);

    return result;
  }

  /**
   * Evaluate a feature flag requirement
   *
   * @param requirement - The flag requirement (single, any, or all)
   * @param accessToken - The user's access token
   */
  async evaluateRequirement(requirement: FeatureFlagRequirement, accessToken: string): Promise<boolean> {
    if (typeof requirement === 'string') {
      return this.isEnabled(requirement, accessToken);
    }

    if ('any' in requirement) {
      const results = await Promise.all(
        requirement.any.map((flag) => this.isEnabled(flag, accessToken))
      );
      return results.some(Boolean);
    }

    if ('all' in requirement) {
      const results = await Promise.all(
        requirement.all.map((flag) => this.isEnabled(flag, accessToken))
      );
      return results.every(Boolean);
    }

    return true;
  }

  /**
   * TBP-756 — why a requirement that `evaluateRequirement` just refused is
   * off, from the reasons Bridge sent with that evaluation (no extra call):
   *   - one flag: that flag's reason;
   *   - `any`: every flag failed; the one closest to "an upgrade alone opens
   *     it" decides, since opening any one is enough;
   *   - `all`: of the failing flags, the one furthest from it decides.
   * A failing flag without a reason leaves the explanation empty.
   */
  explainFailure(requirement: FeatureFlagRequirement, accessToken: string): RequirementVerdict {
    const flags =
      typeof requirement === 'string'
        ? [requirement]
        : 'any' in requirement
          ? requirement.any
          : 'all' in requirement
            ? requirement.all
            : null;
    if (!flags) return { ok: true };
    const cacheKey = this.getCacheKey(accessToken);
    const isAny = typeof requirement !== 'string' && 'any' in requirement;
    // A flag counts as failing unless the cache says it is on.
    const failing = flags.filter((flag) => this.cache.get(cacheKey)?.get(flag) !== true);
    if (failing.length === 0) return { ok: false };

    let pick: { flag: string; explanation: FeatureOffExplanation & { reason: FeatureOffReason } } | undefined;
    for (const flag of failing) {
      const explanation = this.getReason(flag, accessToken);
      if (!explanation?.reason) return { ok: false, flag: failing[0] };
      const e = explanation as FeatureOffExplanation & { reason: FeatureOffReason };
      const better =
        !pick ||
        (isAny
          ? REASON_RANK[e.reason] < REASON_RANK[pick.explanation.reason]
          : REASON_RANK[e.reason] > REASON_RANK[pick.explanation.reason]);
      if (better) pick = { flag, explanation: e };
    }
    return pick
      ? { ok: false, flag: pick.flag, explanation: pick.explanation }
      : { ok: false, flag: failing[0] };
  }

  /** TBP-756 — why `flag` was off for this token at its last evaluation, if Bridge said. */
  getReason(flag: string, accessToken: string): FeatureOffExplanation | undefined {
    return this.reasons.get(this.getCacheKey(accessToken))?.get(flag);
  }

  private setReason(cacheKey: string, flag: string, explanation: FeatureOffExplanation): void {
    let map = this.reasons.get(cacheKey);
    if (!map) {
      map = new Map();
      this.reasons.set(cacheKey, map);
    }
    if (explanation.reason) map.set(flag, explanation);
    else map.delete(flag);
  }

  /**
   * Bulk evaluate all flags for a user
   */
  async bulkEvaluate(accessToken: string): Promise<Map<string, boolean>> {
    const cacheKey = this.getCacheKey(accessToken);
    const now = Date.now();

    // Check if we have a recent bulk cache
    const cacheTimestamp = this.cacheTimestamps.get(cacheKey);
    if (cacheTimestamp && now - cacheTimestamp < this.CACHE_TTL_MS) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        this.configService.log('Returning bulk flags from cache');
        return cached;
      }
    }

    // Make bulk API call
    const url = `${this.configService.cloudViewsBaseUrl}/flags/bulkEvaluate/${this.configService.appId}`;

    this.configService.log('Bulk evaluating feature flags', { url });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken }),
      });

      if (!response.ok) {
        this.configService.log('Bulk evaluate failed', { status: response.status });
        return new Map();
      }

      const data: BulkEvaluateResponse = await response.json();
      const flags = new Map<string, boolean>();

      this.reasons.delete(cacheKey);
      for (const { flag, evaluation } of data.flags) {
        const enabled = evaluation?.enabled ?? false;
        flags.set(flag, enabled);
        if (!enabled) this.setReason(cacheKey, flag, readExplanation(evaluation));
      }

      // Update cache
      this.cache.set(cacheKey, flags);
      this.cacheTimestamps.set(cacheKey, now);

      this.configService.log('Bulk evaluate complete', { flagCount: flags.size });
      return flags;
    } catch (error) {
      this.configService.log('Bulk evaluate error', error);
      return new Map();
    }
  }

  /**
   * Evaluate a single flag via API
   */
  private async evaluateSingleFlag(flag: string, accessToken: string): Promise<boolean> {
    const url = `${this.configService.cloudViewsBaseUrl}/flags/evaluate/${this.configService.appId}/${flag}`;

    this.configService.log('Evaluating single flag', { flag, url });

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessToken }),
      });

      if (!response.ok) {
        this.configService.log('Single flag evaluate failed', { flag, status: response.status });
        return false;
      }

      const data = await response.json();
      const enabled = data.enabled ?? false;
      this.setReason(this.getCacheKey(accessToken), flag, enabled ? {} : readExplanation(data));

      this.configService.log(`Flag '${flag}' evaluated: ${enabled}`);
      return enabled;
    } catch (error) {
      this.configService.log('Single flag evaluate error', { flag, error });
      return false;
    }
  }

  /**
   * Generate a cache key from the access token.
   *
   * TBP-517 — this used to be `accessToken.substring(0, 16)`. Those 16
   * base64url characters cover only the first 12 bytes of the JWT *protected
   * header*, which decode to the literal `{"alg":"PS25` for every token
   * bridge-api issues. The `kid` starts at byte 28 of the header JSON, well
   * past the cut, so not even key rotation moved it. The "key" was therefore a
   * constant: every user of an app shared a single cache entry, the first
   * caller warmed it, and everyone else was served that user's evaluations for
   * the full TTL — defeating role, plan, tenant and percentage-rollout
   * targeting across user boundaries.
   *
   * Hashing the whole token restores a genuinely per-caller key. We hash rather
   * than key on the raw token so the map keys are fixed-width and the bearer
   * credential does not sit in a long-lived in-process structure that ends up
   * in heap dumps and debug output.
   *
   * Deliberately NOT keyed on the resolved `sub` (+ tenant): this service never
   * parses or verifies the token, and claim-level keying would merge two tokens
   * for the same subject whose *claims* differ — a re-login or refresh after a
   * role, plan or tenant change would then read a stale entry belonging to the
   * pre-change token. The full-token hash is the finest-grained key available
   * and preserves the existing per-token TTL semantics exactly.
   */
  private getCacheKey(accessToken: string): string {
    return createHash('sha256').update(accessToken).digest('hex');
  }

  /**
   * Get a cached flag value if not expired
   */
  private getCachedValue(cacheKey: string, flag: string, now: number): boolean | undefined {
    const cacheTimestamp = this.cacheTimestamps.get(cacheKey);
    if (!cacheTimestamp || now - cacheTimestamp > this.CACHE_TTL_MS) {
      return undefined;
    }

    const flagCache = this.cache.get(cacheKey);
    if (!flagCache) {
      return undefined;
    }

    return flagCache.get(flag);
  }

  /**
   * Set a cached flag value
   */
  private setCachedValue(cacheKey: string, flag: string, value: boolean, now: number): void {
    let flagCache = this.cache.get(cacheKey);
    if (!flagCache) {
      flagCache = new Map();
      this.cache.set(cacheKey, flagCache);
    }
    flagCache.set(flag, value);

    if (!this.cacheTimestamps.has(cacheKey)) {
      this.cacheTimestamps.set(cacheKey, now);
    }
  }

  /**
   * Clear all cached flags
   */
  clearCache(): void {
    this.cache.clear();
    this.cacheTimestamps.clear();
    this.reasons.clear();
  }
}
