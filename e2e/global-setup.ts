/**
 * Jest globalSetup — runs once before all E2E test suites (in a separate process).
 *
 * Responsibilities:
 *   1. Load .env.test.local so environment variables are available.
 *   2. Validate that required env vars are present.
 *   3. Purge stale test accounts from the previous run.
 *
 * Note: globalSetup runs in its own process, so it cannot share module-level
 * state with tests. Use process.env (written by load-test-env.ts setupFiles)
 * for cross-process communication, or write to a temp file.
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

export default async function globalSetup() {
  // Load env (globalSetup doesn't go through setupFiles)
  dotenv.config({ path: path.join(__dirname, 'config', '.env.test.local') });

  const appId = process.env.BRIDGE_TEST_APP_ID;
  const apiKey = process.env.PLAYWRIGHT_TEST_API_KEY;
  const testDataApiUrl =
    process.env.LOCAL_TEST_DATA_API_URL || 'http://localhost:3200';
  const appDomain = process.env.APP_DOMAIN || 'BRIDGE_EXPRESS_E2E_TEST';

  if (!appId) {
    throw new Error(
      'BRIDGE_TEST_APP_ID is not set. Run `npm run e2e:setup` first.',
    );
  }
  if (!apiKey) {
    throw new Error(
      'PLAYWRIGHT_TEST_API_KEY is not set. Check e2e/config/.env.test.local.',
    );
  }

  console.log(`\n[e2e/global-setup] App ID: ${appId}`);
  console.log(`[e2e/global-setup] Test data API: ${testDataApiUrl}`);

  // Purge stale test accounts from previous run
  try {
    const purgeResp = await fetch(
      `${testDataApiUrl}/account/test/playwright/purge`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-playwright-api-key': apiKey,
        },
        body: JSON.stringify({ appDomain }),
      },
    );

    if (purgeResp.ok) {
      const result = (await purgeResp.json()) as { purgedCount?: number };
      const count = result.purgedCount ?? 0;
      if (count > 0) {
        console.log(`[e2e/global-setup] Purged ${count} stale test account(s).`);
      }
    } else {
      // Non-fatal — log and continue
      console.warn(
        `[e2e/global-setup] purge returned ${purgeResp.status} — continuing.`,
      );
    }
  } catch (err: any) {
    console.warn(`[e2e/global-setup] purge error: ${err.message} — continuing.`);
  }
}
