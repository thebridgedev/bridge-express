import { BridgeConfigService } from './bridge-config.service';
import { BRIDGE_DEFAULTS } from '../types/config';

function makeService(overrides: Record<string, any> = {}): BridgeConfigService {
  const config = {
    appId: 'test-app',
    ...overrides,
  };
  return new BridgeConfigService(config as any);
}

describe('BridgeConfigService', () => {
  describe('defaults', () => {
    it('should use default authBaseUrl when not provided', () => {
      const svc = makeService();
      expect(svc.authBaseUrl).toBe(BRIDGE_DEFAULTS.authBaseUrl);
    });

    it('should use default backendlessBaseUrl when not provided', () => {
      const svc = makeService();
      expect(svc.backendlessBaseUrl).toBe(BRIDGE_DEFAULTS.backendlessBaseUrl);
    });

    it('should default debug to false', () => {
      const svc = makeService();
      expect(svc.debug).toBe(false);
    });

    it('should default defaultAccess to protected', () => {
      const svc = makeService();
      expect(svc.defaultAccess).toBe('protected');
    });
  });

  describe('jwksUrl', () => {
    it('should compute jwksUrl from authBaseUrl', () => {
      const svc = makeService({ authBaseUrl: 'https://auth.example.com' });
      expect(svc.jwksUrl).toBe('https://auth.example.com/.well-known/jwks.json');
    });
  });

  describe('findMatchingRule', () => {
    const rules = [
      { path: '/health', public: true },
      { path: '/admin/*', role: 'ADMIN' },
      { path: '/items', methods: ['GET'] as any },
    ];
    let svc: BridgeConfigService;

    beforeEach(() => {
      svc = makeService({ guard: { rules } });
    });

    it('should return exact match', () => {
      const rule = svc.findMatchingRule('/health', 'GET');
      expect(rule).not.toBeNull();
      expect(rule!.path).toBe('/health');
    });

    it('should return wildcard match', () => {
      const rule = svc.findMatchingRule('/admin/users', 'GET');
      expect(rule).not.toBeNull();
      expect(rule!.path).toBe('/admin/*');
    });

    it('should respect method filter', () => {
      const rule = svc.findMatchingRule('/items', 'GET');
      expect(rule).not.toBeNull();

      const noRule = svc.findMatchingRule('/items', 'POST');
      expect(noRule).toBeNull();
    });

    it('should return null when no rule matches', () => {
      const rule = svc.findMatchingRule('/unknown/path', 'GET');
      expect(rule).toBeNull();
    });
  });

  describe('pathMatches (via findMatchingRule)', () => {
    let svc: BridgeConfigService;

    beforeEach(() => {
      svc = makeService({
        guard: {
          rules: [
            { path: '/exact', public: true },
            { path: '/wildcard/*', public: true },
            { path: 'no-leading-slash', public: true },
          ],
        },
      });
    });

    it('should match exact paths', () => {
      expect(svc.findMatchingRule('/exact', 'GET')).not.toBeNull();
    });

    it('should match wildcard patterns', () => {
      expect(svc.findMatchingRule('/wildcard/foo', 'GET')).not.toBeNull();
      expect(svc.findMatchingRule('/wildcard/foo/bar', 'GET')).not.toBeNull();
    });

    it('should not match when path differs', () => {
      expect(svc.findMatchingRule('/other', 'GET')).toBeNull();
    });

    it('should handle pattern without leading slash', () => {
      expect(svc.findMatchingRule('/no-leading-slash', 'GET')).not.toBeNull();
    });
  });

  describe('log', () => {
    it('should log when debug is true', () => {
      const svc = makeService({ debug: true });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      svc.log('test message');
      expect(spy).toHaveBeenCalledWith('[Bridge] test message');
      spy.mockRestore();
    });

    it('should not log when debug is false', () => {
      const svc = makeService({ debug: false });
      const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
      svc.log('test message');
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });
});
