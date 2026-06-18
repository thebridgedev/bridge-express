/**
 * Client for interacting with the Bridge Playwright test data API.
 *
 * Adapted from bridge-svelte/e2e/playwright/utils/test-data-client.ts
 * See bridge-api docs/tests/PLAYWRIGHT_PATTERNS.md for API patterns.
 */

import { EnvironmentConfig } from '../config/environments';

export interface PlaywrightTestAccount {
  email: string;
  password: string;
  userId: string;
  tenantId: string;
  appId: string;
}

export interface CreateTestAccountOptions {
  email?: string;
  password?: string;
  tenantName?: string;
  firstName?: string;
  lastName?: string;
}

export class TestDataClient {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly appDomain: string;

  constructor(config: EnvironmentConfig) {
    this.baseUrl = config.testDataApiUrl;
    this.apiKey = config.testDataApiKey;
    this.appDomain = config.appDomain;
  }

  /**
   * Creates a test account (user + tenant) within the test app.
   *
   * The account is scoped to `appDomain`. Call `removeTestAccount` in test
   * teardown to keep the app clean between runs.
   */
  async createTestAccount(
    options?: CreateTestAccountOptions,
  ): Promise<PlaywrightTestAccount> {
    const response = await fetch(
      `${this.baseUrl}/account/test/playwright/account`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-playwright-api-key': this.apiKey,
        },
        body: JSON.stringify({ appDomain: this.appDomain, ...options }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to create test account: ${response.status} ${error}`,
      );
    }

    return response.json();
  }

  /**
   * Removes a test account created by E2E tests.
   */
  async removeTestAccount(email: string): Promise<void> {
    const response = await fetch(
      `${this.baseUrl}/account/test/playwright/account`,
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'x-playwright-api-key': this.apiKey,
        },
        body: JSON.stringify({ email, appDomain: this.appDomain }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to remove test account: ${response.status} ${error}`,
      );
    }
  }

  /**
   * Sets up a persistent test app (idempotent).
   *
   * Creates a new app with a unique domain if it doesn't exist, or returns
   * the existing one. The app persists across test runs.
   */
  async setupTestApp(
    domain: string,
    appName: string,
    ownerEmail: string,
    ownerPassword?: string,
    appUrl?: string,
  ): Promise<{
    appId: string;
    domain: string;
    tenantId: string;
    userId: string;
    email: string;
    message: string;
  }> {
    const response = await fetch(
      `${this.baseUrl}/account/test/playwright/setup-test-app`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-playwright-api-key': this.apiKey,
        },
        body: JSON.stringify({
          domain,
          appName,
          ownerEmail,
          ownerPassword,
          appUrl,
        }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to setup test app: ${response.status} ${error}`,
      );
    }

    return response.json();
  }

  /**
   * Health check — verifies the test data API is reachable and the API key works.
   */
  async healthCheck(): Promise<{ success: boolean; diagnostics?: string }> {
    try {
      const response = await fetch(
        `${this.baseUrl}/account/test/playwright/health`,
        {
          method: 'GET',
          headers: { 'x-playwright-api-key': this.apiKey },
        },
      );

      if (!response.ok) {
        const body = await response.text();
        const diagnostics = [
          `Health check failed: ${response.status} ${response.statusText}`,
          `API Key: ${this.apiKey ? `SET (${this.apiKey.substring(0, 8)}...)` : 'MISSING'}`,
          `Response: ${body}`,
        ].join(' | ');
        return { success: false, diagnostics };
      }

      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        diagnostics: `Health check error: ${error.message} — URL: ${this.baseUrl}`,
      };
    }
  }

  /**
   * Purges all Playwright test accounts for the app domain.
   *
   * @returns Number of accounts purged
   */
  async purgeTestAccounts(): Promise<number> {
    const response = await fetch(
      `${this.baseUrl}/account/test/playwright/purge`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-playwright-api-key': this.apiKey,
        },
        body: JSON.stringify({ appDomain: this.appDomain }),
      },
    );

    if (!response.ok) {
      const error = await response.text();
      throw new Error(
        `Failed to purge test accounts: ${response.status} ${error}`,
      );
    }

    const result = await response.json();
    return result.purgedCount ?? 0;
  }
}
