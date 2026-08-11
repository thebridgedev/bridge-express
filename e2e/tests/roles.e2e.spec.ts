/**
 * E2E: Role-Based Access Control
 *
 * Tests that the ADMIN role guard enforces access correctly on /admin/users:
 *   - Unauthenticated request → 401
 *   - A user whose role is not ADMIN → 403
 *
 * The demo gates /admin/users per-route with:
 *   bridge.protect({ role: 'ADMIN' })
 * (the @RequireRole('ADMIN') analogue), enforced after the global bridge.auth()
 * middleware authenticates the user JWT.
 *
 * Test accounts created by TestDataClient own their own tenant, so the first
 * (and only) user of that tenant carries the OWNER role — NOT ADMIN. That makes
 * the freshly-created account the natural wrong-role subject for the 403 path:
 * a valid, authenticated user whose role does not satisfy the ADMIN gate.
 */

import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig } from '../config/environments';

describe('RBAC — /admin/users requires ADMIN role (E2E)', () => {
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let userAccount: PlaywrightTestAccount;
  let userToken: string;

  beforeAll(async () => {
    const config = getEnvironmentConfig();
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // A freshly-created account is the OWNER of its own tenant — its role is
    // OWNER, not ADMIN, so it is the natural non-ADMIN subject for the 403 path.
    userAccount = await testDataClient.createTestAccount();
    userToken = (
      await authClient.getToken(userAccount.email, userAccount.password)
    ).accessToken;

    request = supertest(createTestApp(config));
  });

  afterAll(async () => {
    await testDataClient.removeTestAccount(userAccount.email).catch(() => {});
  });

  it('returns 401 for unauthenticated requests to /admin/users', async () => {
    const res = await request.get('/admin/users');
    expect(res.status).toBe(401);
  });

  it('returns 403 when a non-admin (OWNER-role) user accesses /admin/users', async () => {
    const res = await request
      .get('/admin/users')
      .set('Authorization', `Bearer ${userToken}`);
    // The user's role is OWNER, which does not satisfy the ADMIN gate.
    expect(res.status).toBe(403);
  });
});
