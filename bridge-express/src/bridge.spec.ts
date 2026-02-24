// jose is ESM-only; mock it so CJS jest can load the module graph
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
  errors: {
    JWTExpired: class extends Error {},
    JWTInvalid: class extends Error {},
    JWKSNoMatchingKey: class extends Error {},
    JWTClaimValidationFailed: class extends Error {},
  },
}));

import { createBridge } from './bridge';
import { BridgeHttpService } from './services/bridge-http.service';

describe('createBridge', () => {
  const config = {
    appId: 'test-app',
    guard: {
      defaultAccess: 'protected' as const,
      rules: [{ path: '/health', public: true }],
    },
  };

  it('should return an instance with auth, protect, public, and http', () => {
    const bridge = createBridge(config);

    expect(typeof bridge.auth).toBe('function');
    expect(typeof bridge.protect).toBe('function');
    expect(typeof bridge.public).toBe('function');
    expect(bridge.http).toBeDefined();
  });

  it('bridge.http should be a BridgeHttpService instance', () => {
    const bridge = createBridge(config);
    expect(bridge.http).toBeInstanceOf(BridgeHttpService);
  });

  it('bridge.auth() should return a function (RequestHandler)', () => {
    const bridge = createBridge(config);
    const handler = bridge.auth();
    expect(typeof handler).toBe('function');
  });

  it('bridge.protect() should return a function (RequestHandler)', () => {
    const bridge = createBridge(config);
    const handler = bridge.protect({ role: 'ADMIN' });
    expect(typeof handler).toBe('function');
  });

  it('bridge.public() should return a function (RequestHandler)', () => {
    const bridge = createBridge(config);
    const handler = bridge.public();
    expect(typeof handler).toBe('function');
  });

  it('bridge.public() handler should set __bridgePublic flag', () => {
    const bridge = createBridge(config);
    const handler = bridge.public();

    const req: any = {};
    const res: any = {};
    const next = jest.fn();

    handler(req, res, next);

    expect(req.__bridgePublic).toBe(true);
    expect(next).toHaveBeenCalled();
  });
});
