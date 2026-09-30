/**
 * E2E: API Token authentication via the Bridge auth middleware
 *
 * Tests the API token (x-api-key header) path of bridge.protect():
 *   - Valid API token with the required privilege → 200
 *   - Unverifiable / wrong-app token → 401
 *   - No token → 401
 *   - acceptAuth: 'api_token' rejects a user-JWT-only caller → 401
 *   - privilege present, token has privilege → 200
 *   - privilege present, token missing privilege → 403
 *   - privilege present, token with empty privileges array → 403
 *
 * Mirrors bridge-nestjs's inline-controller pattern: instead of Nest controllers
 * we build inline Express routes with createBridge(...).protect(...), wired to
 * the real bridge-api for token issuance + introspection.
 *
 * The demo's M2M route is:
 *   POST /integrations/sync  bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' })
 * The inline routes below reproduce that shape so the assertions match the demo.
 */

import express, { Express } from 'express';
import supertest from 'supertest';
import { createBridge } from '@nebulr-group/bridge-express';
import { TestDataClient, PlaywrightTestAccount } from '../utils/test-data-client';
import { AuthClient } from '../utils/auth-client';
import { getEnvironmentConfig, EnvironmentConfig } from '../config/environments';

// ---------------------------------------------------------------------------
// Inline test app — two API-token routes (protected + privileged)
// ---------------------------------------------------------------------------

function buildApiTokenApp(config: EnvironmentConfig): Express {
  const app = express();
  app.use(express.json());

  const bridge = createBridge({
    appId: config.appId,
    apiBaseUrl: config.testDataApiUrl,
    guard: { defaultAccess: 'protected' },
  });

  // Accepts an API token (x-api-key), no specific privilege required.
  app.post(
    '/api-token-test/protected',
    bridge.protect({ acceptAuth: 'api_token' }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  // Accepts an API token and requires the TENANT_WRITE privilege.
  app.post(
    '/api-token-test/privileged',
    bridge.protect({ acceptAuth: 'api_token', privilege: 'TENANT_WRITE' }),
    (_req, res) => {
      res.json({ ok: true });
    },
  );

  return app;
}

// ---------------------------------------------------------------------------
// Helper: the app's own API key
//
// Minting an API token is app administration. Since TBP-771 bridge-api refuses
// a person's sign-in session on those routes ("App administration requires the
// app's API key or the Bridge dashboard; a user session is not accepted") and
// admits only a server-side credential: the app's API key as `x-api-key`, or
// the dashboard's internal service token. That is how a developer's backend,
// auth-core `BridgeManagement` and the CLI create tokens.
//
// The test-data API mints that app key for the e2e app's domain — the same call
// bridge-nestjs's e2e and bridge-api's own e2e global-setup use. Like any API
// key it carries only the privileges it was minted with; creating tokens needs
// TOKEN_WRITE. The playwright test-data key (`x-playwright-api-key`) is a
// different credential and is only accepted by the test-data routes.
// ---------------------------------------------------------------------------

async function generateAppApiKey(config: EnvironmentConfig): Promise<string> {
  const res = await fetch(`${config.testDataApiUrl}/account/test/playwright/generate-jwt`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-playwright-api-key': config.testDataApiKey,
    },
    body: JSON.stringify({ appDomain: config.appDomain, privileges: ['TOKEN_WRITE'] }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to generate the app API key for ${config.appDomain} (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token?: string };
  if (!data.token) throw new Error(`generate-jwt returned no token for ${config.appDomain}`);
  return data.token;
}

// ---------------------------------------------------------------------------
// Helper: create an API token via the bridge-api, as the app
// ---------------------------------------------------------------------------

async function createApiToken(
  testDataApiUrl: string,
  appApiKey: string,
  privileges: string[],
): Promise<string> {
  const res = await fetch(`${testDataApiUrl}/account/api-token/app`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': appApiKey,
    },
    body: JSON.stringify({ name: `E2E test token ${Date.now()}`, privileges }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create API token (${res.status}): ${body}`);
  }

  const data = (await res.json()) as { token: string };
  return data.token;
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('API token authentication (E2E)', () => {
  let request: supertest.Agent;
  let testDataClient: TestDataClient;
  let authClient: AuthClient;
  let account: PlaywrightTestAccount;
  let userAccessToken: string;
  let apiTokenWithPrivilege: string;

  const config = getEnvironmentConfig();

  beforeAll(async () => {
    testDataClient = new TestDataClient(config);
    authClient = new AuthClient(config.authBaseUrl, config.appId);

    // A test user's JWT — only for the "user JWT is not an API token" case.
    account = await testDataClient.createTestAccount();
    userAccessToken = (await authClient.getToken(account.email, account.password)).accessToken;

    // Mint an API token via bridge-api, as the app (its API key).
    const appApiKey = await generateAppApiKey(config);
    apiTokenWithPrivilege = await createApiToken(config.testDataApiUrl, appApiKey, ['TENANT_WRITE']);

    request = supertest(buildApiTokenApp(config));
  });

  afterAll(async () => {
    await testDataClient.removeTestAccount(account.email).catch(() => {});
  });

  it('POST /api-token-test/protected with valid API token → 200', async () => {
    const res = await request
      .post('/api-token-test/protected')
      .set('x-api-key', apiTokenWithPrivilege);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /api-token-test/protected with unverifiable token → 401', async () => {
    // A JWT-shaped but unverifiable string — introspection fails.
    const fakeToken =
      'eyJhbGciOiJIUzI1NiJ9.eyJhcHBJZCI6Im90aGVyLWFwcCIsInR5cGUiOiJhcGkiLCJwcml2aWxlZ2VzIjpbXX0.fakeSignature';
    const res = await request
      .post('/api-token-test/protected')
      .set('x-api-key', fakeToken);
    expect(res.status).toBe(401);
  });

  it('POST /api-token-test/protected with no token → 401', async () => {
    const res = await request.post('/api-token-test/protected');
    expect(res.status).toBe(401);
  });

  it('POST /api-token-test/protected with user JWT only → 401 (acceptAuth: api_token)', async () => {
    const res = await request
      .post('/api-token-test/protected')
      .set('Authorization', `Bearer ${userAccessToken}`);
    expect(res.status).toBe(401);
  });
});

describe('Privilege enforcement (E2E)', () => {
  let request: supertest.Agent;
  let tokenWithPrivilege: string;
  let tokenMissingPrivilege: string;
  let tokenEmptyPrivileges: string;

  const config = getEnvironmentConfig();

  beforeAll(async () => {
    const appApiKey = await generateAppApiKey(config);
    tokenWithPrivilege = await createApiToken(config.testDataApiUrl, appApiKey, ['TENANT_WRITE']);
    tokenMissingPrivilege = await createApiToken(config.testDataApiUrl, appApiKey, ['TENANT_READ']);
    tokenEmptyPrivileges = await createApiToken(config.testDataApiUrl, appApiKey, []);

    request = supertest(buildApiTokenApp(config));
  });

  it('POST /api-token-test/privileged with token carrying TENANT_WRITE → 200', async () => {
    const res = await request
      .post('/api-token-test/privileged')
      .set('x-api-key', tokenWithPrivilege);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('POST /api-token-test/privileged with token missing TENANT_WRITE → 403', async () => {
    const res = await request
      .post('/api-token-test/privileged')
      .set('x-api-key', tokenMissingPrivilege);
    expect(res.status).toBe(403);
  });

  it('POST /api-token-test/privileged with API token, empty privileges array → 403', async () => {
    const res = await request
      .post('/api-token-test/privileged')
      .set('x-api-key', tokenEmptyPrivileges);
    expect(res.status).toBe(403);
  });
});
