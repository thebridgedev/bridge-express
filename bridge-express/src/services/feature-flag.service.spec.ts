import { FeatureFlagService } from './feature-flag.service';
import { BridgeConfigService } from './bridge-config.service';

const mockConfigService = {
  cloudViewsBaseUrl: 'https://api.example.com/cloud-views',
  appId: 'test-app',
  log: jest.fn(),
} as unknown as BridgeConfigService;

// Helper: token that is long enough for getCacheKey
const TOKEN = 'a'.repeat(20);

function mockFetchOk(body: object): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(body),
  } as any);
}

function mockFetchFail(status = 500): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  } as any);
}

describe('FeatureFlagService', () => {
  let service: FeatureFlagService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new FeatureFlagService(mockConfigService);
  });

  describe('isEnabled', () => {
    it('should call bulk evaluate on first call and return flag value', async () => {
      mockFetchOk({
        flags: [
          { flag: 'beta-access', evaluation: { enabled: true } },
          { flag: 'premium', evaluation: { enabled: false } },
        ],
      });

      const result = await service.isEnabled('beta-access', TOKEN);
      expect(result).toBe(true);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should return cached value on second call within TTL', async () => {
      mockFetchOk({
        flags: [{ flag: 'beta-access', evaluation: { enabled: true } }],
      });

      await service.isEnabled('beta-access', TOKEN);
      const result = await service.isEnabled('beta-access', TOKEN);

      expect(result).toBe(true);
      // fetch should only be called once (for bulk evaluate)
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('should bypass cache when forceLive is true', async () => {
      mockFetchOk({ enabled: true });

      await service.isEnabled('beta-access', TOKEN, true);
      await service.isEnabled('beta-access', TOKEN, true);

      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('should return false gracefully when single evaluate fails', async () => {
      mockFetchFail();
      const result = await service.isEnabled('missing-flag', TOKEN, true);
      expect(result).toBe(false);
    });
  });

  describe('evaluateRequirement', () => {
    it('should evaluate a string flag', async () => {
      mockFetchOk({ flags: [{ flag: 'my-flag', evaluation: { enabled: true } }] });
      const result = await service.evaluateRequirement('my-flag', TOKEN);
      expect(result).toBe(true);
    });

    it('should return true if any flag is enabled (any requirement)', async () => {
      mockFetchOk({
        flags: [
          { flag: 'flag-a', evaluation: { enabled: false } },
          { flag: 'flag-b', evaluation: { enabled: true } },
        ],
      });

      const result = await service.evaluateRequirement({ any: ['flag-a', 'flag-b'] }, TOKEN);
      expect(result).toBe(true);
    });

    it('should return false if no flag is enabled (any requirement)', async () => {
      mockFetchOk({
        flags: [
          { flag: 'flag-a', evaluation: { enabled: false } },
          { flag: 'flag-b', evaluation: { enabled: false } },
        ],
      });

      const result = await service.evaluateRequirement({ any: ['flag-a', 'flag-b'] }, TOKEN);
      expect(result).toBe(false);
    });

    it('should return true if all flags are enabled (all requirement)', async () => {
      mockFetchOk({
        flags: [
          { flag: 'flag-a', evaluation: { enabled: true } },
          { flag: 'flag-b', evaluation: { enabled: true } },
        ],
      });

      const result = await service.evaluateRequirement({ all: ['flag-a', 'flag-b'] }, TOKEN);
      expect(result).toBe(true);
    });

    it('should return false if any flag is disabled (all requirement)', async () => {
      mockFetchOk({
        flags: [
          { flag: 'flag-a', evaluation: { enabled: true } },
          { flag: 'flag-b', evaluation: { enabled: false } },
        ],
      });

      const result = await service.evaluateRequirement({ all: ['flag-a', 'flag-b'] }, TOKEN);
      expect(result).toBe(false);
    });
  });

  describe('bulkEvaluate', () => {
    it('should return empty map when bulk evaluate fails', async () => {
      mockFetchFail();
      const result = await service.bulkEvaluate(TOKEN);
      expect(result.size).toBe(0);
    });

    it('should return empty map when fetch throws', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('network error'));
      const result = await service.bulkEvaluate(TOKEN);
      expect(result.size).toBe(0);
    });

    it('should POST to the cloud-views bulkEvaluate endpoint for the app', async () => {
      const fetchMock = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ flags: [] }),
      } as any);
      global.fetch = fetchMock;

      await service.bulkEvaluate(TOKEN);

      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.example.com/cloud-views/flags/bulkEvaluate/test-app');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ accessToken: TOKEN });
    });
  });
});
