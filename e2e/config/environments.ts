/**
 * Environment configuration for bridge-express E2E tests.
 *
 * Pattern borrowed from bridge-nestjs/e2e/config/environments.ts
 */

export interface EnvironmentConfig {
  /** Auth service URL (e.g., http://localhost:3200/auth) */
  authBaseUrl: string;
  /** API URL for test data operations (bridge-api base URL, no /auth suffix) */
  testDataApiUrl: string;
  /** API key for test data service authentication (x-playwright-api-key) */
  testDataApiKey: string;
  /** Bridge App ID used by the demo app */
  appId: string;
  /** App domain for test data operations */
  appDomain: string;
  /** Environment name */
  name: 'local' | 'stage' | 'prod';
}

/**
 * Get the current environment configuration.
 *
 * Reads environment variables — ensure load-test-env.ts has run first
 * (Jest setupFiles loads e2e/config/.env.test.local automatically).
 */
export function getEnvironmentConfig(
  environment: 'local' | 'stage' | 'prod' = getCurrentEnvironment(),
): EnvironmentConfig {
  const testDataApiKey = requireEnv('PLAYWRIGHT_TEST_API_KEY');
  const appId = requireEnv('BRIDGE_TEST_APP_ID');
  const appDomain = process.env.APP_DOMAIN || 'BRIDGE_EXPRESS_E2E_TEST';

  switch (environment) {
    case 'local':
      return {
        name: 'local',
        authBaseUrl:
          process.env.LOCAL_AUTH_BASE_URL || 'http://localhost:3200/auth',
        testDataApiUrl:
          process.env.LOCAL_TEST_DATA_API_URL || 'http://localhost:3200',
        testDataApiKey,
        appId,
        appDomain,
      };

    case 'stage':
      return {
        name: 'stage',
        authBaseUrl: requireEnv('STAGE_AUTH_BASE_URL'),
        testDataApiUrl: requireEnv('STAGE_TEST_DATA_API_URL'),
        testDataApiKey,
        appId,
        appDomain,
      };

    case 'prod':
      return {
        name: 'prod',
        authBaseUrl: requireEnv('PROD_AUTH_BASE_URL'),
        testDataApiUrl: requireEnv('PROD_TEST_DATA_API_URL'),
        testDataApiKey,
        appId,
        appDomain,
      };
  }
}

/**
 * Determine current environment from E2E_ENV variable.
 * Falls back to 'local'.
 */
export function getCurrentEnvironment(): 'local' | 'stage' | 'prod' {
  const env = process.env.E2E_ENV || 'local';
  if (env === 'stage' || env === 'prod') return env;
  return 'local';
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Required environment variable ${name} is not set. ` +
        `Check your e2e/config/.env.test.local file.`,
    );
  }
  return value;
}
