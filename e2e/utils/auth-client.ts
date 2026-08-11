/**
 * Programmatic token client for the Bridge auth server.
 *
 * Uses the SDK "direct" flow — the same path the auth-core SDK ships
 * (see auth-core/src/direct-auth.ts) — to obtain a real user access token
 * without a browser, in two stateless calls (no cookies, no redirects):
 *   1. POST /auth/authenticate  (mode: 'sdk')  — validate credentials → session + tenants
 *   2. POST /token/direct       (mode: 'sdk')  — exchange session for an access token
 *
 * Both calls send an `Origin` header that must be in the test app's allowed
 * origins; it derives from `TEST_APP_URL` (see config/test-app.ts), the same
 * value the app is registered with in pre-setup.ts.
 *
 * Used exclusively in E2E tests to obtain real JWT tokens for authenticated requests.
 */

import { TEST_APP_URL } from '../config/test-app';

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
}

export class AuthClient {
  constructor(
    /** Auth base URL, e.g., http://localhost:3200/auth */
    private readonly authBaseUrl: string,
    private readonly appId: string,
  ) {}

  /**
   * Obtain an access token for the given credentials via the SDK direct flow.
   *
   * @throws Error if either step fails.
   */
  async getToken(email: string, password: string): Promise<TokenSet> {
    const sdkHeaders = {
      'Content-Type': 'application/json',
      // Must match one of the test app's allowed origins (SdkOriginGuard).
      Origin: TEST_APP_URL,
    };

    // ── Step 1: Authenticate (SDK mode) → session + the user's tenant(s) ──────
    const authResp = await fetch(`${this.authBaseUrl}/auth/authenticate`, {
      method: 'POST',
      headers: sdkHeaders,
      body: JSON.stringify({
        username: email,
        password,
        mode: 'sdk',
        appId: this.appId,
      }),
    });

    if (!authResp.ok) {
      throw new Error(
        `[AuthClient] authenticate failed (${authResp.status}): ${await authResp.text()}`,
      );
    }

    const authBody = (await authResp.json()) as {
      session?: string;
      tenantUsers?: Array<{ id: string }>;
    };

    if (!authBody.session || !authBody.tenantUsers?.length) {
      throw new Error(
        '[AuthClient] authenticate response missing session/tenantUsers. ' +
          'Single-tenant test users are expected.',
      );
    }

    // ── Step 2: Exchange the session for tokens (single-tenant test user) ─────
    const tokenResp = await fetch(`${this.authBaseUrl}/token/direct`, {
      method: 'POST',
      headers: sdkHeaders,
      body: JSON.stringify({
        session: authBody.session,
        tenantUserId: authBody.tenantUsers[0].id,
        appId: this.appId,
        scope: 'openid profile email onboarding tenant',
        mode: 'sdk',
      }),
    });

    if (!tokenResp.ok) {
      throw new Error(
        `[AuthClient] token/direct failed (${tokenResp.status}): ${await tokenResp.text()}`,
      );
    }

    const tokens = (await tokenResp.json()) as {
      access_token: string;
      refresh_token: string;
    };

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
    };
  }
}
