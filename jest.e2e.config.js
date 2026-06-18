/**
 * Jest configuration for E2E integration tests.
 *
 * Runs against a real Bridge API (local or stage) using real JWT tokens.
 * Requires the built bridge-express library — build it first:
 *   npm run build && npm run e2e:setup && npm run e2e:test
 *
 * This config is separate from the plugin's jest.config (unit tests) to avoid
 * accidentally running E2E tests in the normal test suite.
 */

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',

  // Only look for e2e specs
  roots: ['<rootDir>/e2e/tests'],
  testMatch: ['**/*.e2e.spec.ts'],

  // Load .env.test.local into process.env before any test files run
  setupFiles: ['<rootDir>/e2e/load-test-env.ts'],

  // Run once before / after all suites (separate process).
  // JS wrappers register ts-node so the TypeScript source can be loaded.
  globalSetup: '<rootDir>/e2e/global-setup.js',
  globalTeardown: '<rootDir>/e2e/global-teardown.js',

  // auth-core ships as native ESM (`"type": "module"`), and bridge-express
  // depends on it. Mirror the plugin's unit jest config so Jest's CJS runner
  // can load it without switching this project to ESM: (1) transform `.js/.mjs`
  // too — not just `.ts` — so auth-core's emitted ESM is down-leveled;
  // (2) whitelist the package in transformIgnorePatterns so Jest stops skipping
  // it in node_modules; (3) strip NodeNext `.js` suffixes from auth-core's
  // internal subpath imports. Without these, every e2e spec crashes at
  // module-load with `SyntaxError: Unexpected token 'export'`.
  transform: {
    '^.+\\.[jt]sx?$': [
      'ts-jest',
      {
        tsconfig: '<rootDir>/tsconfig.e2e.json',
        useESM: false,
        isolatedModules: true,
      },
    ],
  },
  transformIgnorePatterns: [
    'node_modules/(?!(@nebulr-group/bridge-auth-core)/)',
  ],
  moduleNameMapper: {
    '^@nebulr-group/bridge-auth-core/(.*)\\.js$': '@nebulr-group/bridge-auth-core/$1',
  },

  // E2E tests are slower than unit tests — allow up to 30s per test
  testTimeout: 30000,

  // Run suites sequentially to avoid competing for the same test accounts
  maxWorkers: 1,
};
