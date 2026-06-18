import { BridgeConfigService } from './bridge-config.service';
import { FeatureFlagRequirement } from '../types/config';

interface FlagEvaluation {
  flag: string;
  evaluation?: {
    enabled: boolean;
  };
}

interface BulkEvaluateResponse {
  flags: FlagEvaluation[];
}

/**
 * Service for evaluating feature flags via the backendless API
 */
export class FeatureFlagService {
  private cache: Map<string, Map<string, boolean>> = new Map();
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

      for (const { flag, evaluation } of data.flags) {
        flags.set(flag, evaluation?.enabled ?? false);
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

      this.configService.log(`Flag '${flag}' evaluated: ${enabled}`);
      return enabled;
    } catch (error) {
      this.configService.log('Single flag evaluate error', { flag, error });
      return false;
    }
  }

  /**
   * Generate a cache key from the access token (use first 16 chars)
   */
  private getCacheKey(accessToken: string): string {
    return accessToken.substring(0, 16);
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
  }
}
