/**
 * E2E: Bridge auth middleware — token verification and request context
 *
 * Tests the global auth middleware behaviour (bridge.auth()):
 *   - Missing token → 401 with RFC 6750 WWW-Authenticate (missing_token)
 *   - Invalid token  → 401 with RFC 6750 WWW-Authenticate (invalid_token)
 *   - Valid token    → 200 with user/tenant context attached to req
 *
 * The demo /items route is gated by the config rule
 * { path: '/items', privilege: 'AUTHENTICATED' } — any valid user JWT passes.
 */

import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig } from '../config/environments';

describe('Bridge auth middleware (E2E)', () => {
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let account: PlaywrightTestAccount;
  let accessToken: string;

  beforeAll(async () => {
    const config = getEnvironmentConfig();
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // Create a fresh test user for this suite
    account = await testDataClient.createTestAccount();
    accessToken = (await authClient.getToken(account.email, account.password))
      .accessToken;

    request = supertest(createTestApp(config));
  });

  afterAll(async () => {
    await testDataClient.removeTestAccount(account.email).catch(() => {});
  });

  describe('missing token', () => {
    it('returns 401 with RFC 6750 WWW-Authenticate header', async () => {
      const res = await request.get('/items');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/Bearer/);
      expect(res.headers['www-authenticate']).toMatch(/missing_token/);
    });
  });

  describe('invalid token', () => {
    it('returns 401 for a malformed token', async () => {
      const res = await request
        .get('/items')
        .set('Authorization', 'Bearer not.a.real.jwt');
      expect(res.status).toBe(401);
      expect(res.headers['www-authenticate']).toMatch(/invalid_token/);
    });
  });

  describe('valid token', () => {
    it('returns 200 and exposes user context in the response', async () => {
      const res = await request
        .get('/items')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
      expect(res.body.user.email).toBe(account.email);
    });

    it('exposes tenant context in the response', async () => {
      const res = await request
        .get('/items')
        .set('Authorization', `Bearer ${accessToken}`);
      expect(res.status).toBe(200);
      expect(res.body.tenant).toBeDefined();
      expect(res.body.tenant.id).toBe(account.tenantId);
    });
  });
});
