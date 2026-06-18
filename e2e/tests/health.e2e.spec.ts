/**
 * E2E: Public health check endpoint
 *
 * Verifies that GET /health returns 200 without any authentication
 * (config rule: { path: '/health', privilege: 'ANONYMOUS' }).
 */

import supertest from 'supertest';
import { createTestApp } from './_helpers/app-factory';
import { getEnvironmentConfig } from '../config/environments';

describe('GET /health (public)', () => {
  let request: supertest.Agent;

  beforeAll(() => {
    const app = createTestApp(getEnvironmentConfig());
    request = supertest(app);
  });

  it('returns 200 without a token', async () => {
    const res = await request.get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok' });
  });

  it('returns 200 even with an invalid token', async () => {
    const res = await request
      .get('/health')
      .set('Authorization', 'Bearer not-a-real-token');
    expect(res.status).toBe(200);
  });
});
