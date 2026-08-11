// Surface tests for createBridge() — the public factory.
//
// No jose mock needed: the Express JwksService delegates to auth-core/backend
// rather than calling jose directly, and these tests never trigger token
// verification (they only assert the returned middleware factories + http
// client are wired up). BridgeService / TenantScope behavior is covered in
// ./bridge/bridge.spec.ts.

import { createBridge } from './bridge';
import { BridgeHttpService } from './services/bridge-http.service';
import type { BridgeConfig } from './types/config';

const config: BridgeConfig = {
  appId: 'test-app',
  guard: {
    defaultAccess: 'protected',
    rules: [{ path: '/health', privilege: 'ANONYMOUS' }],
  },
};

describe('createBridge', () => {
  it('returns an instance with auth, protect, public, fromJwt, and http', () => {
    const bridge = createBridge(config);

    expect(typeof bridge.auth).toBe('function');
    expect(typeof bridge.protect).toBe('function');
    expect(typeof bridge.public).toBe('function');
    expect(typeof bridge.fromJwt).toBe('function');
    expect(bridge.http).toBeDefined();
  });

  it('bridge.http is a BridgeHttpService instance', () => {
    const bridge = createBridge(config);
    expect(bridge.http).toBeInstanceOf(BridgeHttpService);
  });

  it('bridge.auth() returns a RequestHandler (function)', () => {
    const bridge = createBridge(config);
    expect(typeof bridge.auth()).toBe('function');
  });

  it('bridge.protect() returns a RequestHandler, with or without options', () => {
    const bridge = createBridge(config);
    expect(typeof bridge.protect()).toBe('function');
    expect(typeof bridge.protect({ role: 'ADMIN' })).toBe('function');
    expect(typeof bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' })).toBe(
      'function',
    );
  });

  it('bridge.public() returns a RequestHandler', () => {
    const bridge = createBridge(config);
    expect(typeof bridge.public()).toBe('function');
  });

  it('bridge.public() handler sets the __bridgePublic flag and calls next', () => {
    const bridge = createBridge(config);
    const handler = bridge.public();

    const req: any = {};
    const res: any = {};
    const next = jest.fn();
    handler(req, res, next);

    expect(req.__bridgePublic).toBe(true);
    expect(next).toHaveBeenCalled();
  });

  it('bridge.fromJwt() returns a TenantScope-like object with snapshot slices', () => {
    const bridge = createBridge(config);
    // HS256-shaped JWT — only the payload is decoded for cache keying.
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'u-1', tid: 'tenant-1' })).toString(
      'base64url',
    );
    const scope = bridge.fromJwt(`${header}.${payload}.sig`);

    expect(typeof scope.snapshot).toBe('function');
    expect(typeof scope.invalidate).toBe('function');
    expect(typeof scope.entitlements.can).toBe('function');
  });
});
