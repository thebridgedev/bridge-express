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
    it('should derive authBaseUrl from default apiBaseUrl', () => {
      const svc = makeService();
      expect(svc.authBaseUrl).toBe(`${BRIDGE_DEFAULTS.apiBaseUrl}/auth`);
    });

    it('should derive cloudViewsBaseUrl from default apiBaseUrl', () => {
      const svc = makeService();
      expect(svc.cloudViewsBaseUrl).toBe(`${BRIDGE_DEFAULTS.apiBaseUrl}/cloud-views`);
    });

    it('should expose the resolved apiBaseUrl', () => {
      const svc = makeService();
      expect(svc.apiBaseUrl).toBe(BRIDGE_DEFAULTS.apiBaseUrl);
    });

    it('should default debug to false', () => {
      const svc = makeService();
      expect(svc.debug).toBe(false);
    });

    it('should default defaultAccess to protected', () => {
      const svc = makeService();
      expect(svc.defaultAccess).toBe('protected');
    });

    it('should default rules to an empty array', () => {
      const svc = makeService();
      expect(svc.rules).toEqual([]);
    });

    it('should default introspectionCacheTtlMs to undefined', () => {
      const svc = makeService();
      expect(svc.introspectionCacheTtlMs).toBeUndefined();
    });
  });

  describe('apiBaseUrl override', () => {
    it('should use the provided apiBaseUrl and derive children from it', () => {
      const svc = makeService({ apiBaseUrl: 'https://api.example.com' });
      expect(svc.apiBaseUrl).toBe('https://api.example.com');
      expect(svc.authBaseUrl).toBe('https://api.example.com/auth');
      expect(svc.cloudViewsBaseUrl).toBe('https://api.example.com/cloud-views');
    });
  });

  describe('jwksUrl', () => {
    it('should derive jwksUrl from apiBaseUrl (under /auth)', () => {
      const svc = makeService({ apiBaseUrl: 'https://api.example.com' });
      expect(svc.jwksUrl).toBe('https://api.example.com/auth/.well-known/jwks.json');
    });

    it('should use userJwksUrl override when provided', () => {
      const svc = makeService({
        userJwksUrl: 'http://host.docker.internal:3200/auth/.well-known/jwks.json',
      });
      expect(svc.jwksUrl).toBe('http://host.docker.internal:3200/auth/.well-known/jwks.json');
    });
  });

  describe('introspectionUrl', () => {
    it('should derive introspectionUrl directly under apiBaseUrl (NOT under /auth)', () => {
      const svc = makeService({ apiBaseUrl: 'https://api.example.com' });
      expect(svc.introspectionUrl).toBe('https://api.example.com/account/api-token/introspect');
    });

    it('should use introspectionUrl override when provided', () => {
      const svc = makeService({
        introspectionUrl: 'http://host.docker.internal:3200/account/api-token/introspect',
      });
      expect(svc.introspectionUrl).toBe(
        'http://host.docker.internal:3200/account/api-token/introspect',
      );
    });

    it('should expose introspectionCacheTtlMs when configured', () => {
      const svc = makeService({ introspectionCacheTtlMs: 5000 });
      expect(svc.introspectionCacheTtlMs).toBe(5000);
    });
  });

  describe('findMatchingRule (REST path matching)', () => {
    const rules = [
      { path: '/health', privilege: 'ANONYMOUS' },
      { path: '/admin/*', privilege: 'TENANT_WRITE' },
      { path: '/items', privilege: 'AUTHENTICATED' },
    ];
    let svc: BridgeConfigService;

    beforeEach(() => {
      svc = makeService({ guard: { rules } });
    });

    it('should return exact match', () => {
      const rule = svc.findMatchingRule('/health', 'GET');
      expect(rule).not.toBeNull();
      expect(rule!.path).toBe('/health');
      expect(rule!.privilege).toBe('ANONYMOUS');
    });

    it('should return wildcard match', () => {
      const rule = svc.findMatchingRule('/admin/users', 'GET');
      expect(rule).not.toBeNull();
      expect(rule!.path).toBe('/admin/*');
    });

    it('should match path regardless of method', () => {
      expect(svc.findMatchingRule('/items', 'GET')).not.toBeNull();
      expect(svc.findMatchingRule('/items', 'POST')).not.toBeNull();
    });

    it('should return null when no rule matches', () => {
      expect(svc.findMatchingRule('/unknown/path', 'GET')).toBeNull();
    });
  });

  describe('findMatchingRule (GraphQL operation matching)', () => {
    let svc: BridgeConfigService;

    beforeEach(() => {
      svc = makeService({
        guard: {
          rules: [
            { graphqlOperation: 'listUsers', privilege: 'TENANT_READ' },
            { path: '/health', privilege: 'ANONYMOUS' },
          ],
        },
      });
    });

    it('should match against the GraphQL operation name when provided', () => {
      const rule = svc.findMatchingRule('/graphql', 'POST', 'listUsers');
      expect(rule).not.toBeNull();
      expect(rule!.graphqlOperation).toBe('listUsers');
    });

    it('should return null when no GraphQL operation matches', () => {
      expect(svc.findMatchingRule('/graphql', 'POST', 'createUser')).toBeNull();
    });

    it('should NOT consult REST path rules when an operationName is given', () => {
      // operationName branch only consults graphqlOperation rules
      expect(svc.findMatchingRule('/health', 'GET', 'unknownOp')).toBeNull();
    });
  });

  describe('pathMatches (via findMatchingRule)', () => {
    let svc: BridgeConfigService;

    beforeEach(() => {
      svc = makeService({
        guard: {
          rules: [
            { path: '/exact', privilege: 'ANONYMOUS' },
            { path: '/wildcard/*', privilege: 'ANONYMOUS' },
            { path: 'no-leading-slash', privilege: 'ANONYMOUS' },
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
