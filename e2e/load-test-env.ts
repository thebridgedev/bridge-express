/**
 * Loads e2e/config/.env.test.local into process.env before Jest runs any tests.
 *
 * Listed in jest.e2e.config.js → setupFiles (runs in the test process,
 * before any describe/it blocks, before globalSetup).
 */

import * as dotenv from 'dotenv';
import * as path from 'path';

const envFilePath = path.join(__dirname, 'config', '.env.test.local');
dotenv.config({ path: envFilePath });

// Map the test env into the vars the demo app reads at createBridge() time.
// The demo's `createBridge({ appId: process.env.BRIDGE_APP_ID, apiBaseUrl:
// process.env.BRIDGE_API_BASE_URL })` is evaluated when demo/src/app.ts is
// imported. The app-factory builds its own bridge from EnvironmentConfig, but
// we mirror the father here so the demo app (and any direct importer) boots
// against the test app instead of production defaults.
process.env.BRIDGE_APP_ID = process.env.BRIDGE_TEST_APP_ID;
if (process.env.LOCAL_TEST_DATA_API_URL) {
  process.env.BRIDGE_API_BASE_URL = process.env.LOCAL_TEST_DATA_API_URL;
}
