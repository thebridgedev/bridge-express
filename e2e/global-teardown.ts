/**
 * Jest globalTeardown — runs once after all E2E test suites (in a separate process).
 *
 * Purges any test accounts that were left behind (e.g., by interrupted runs).
 */

import * as path from 'path';
import * as dotenv from 'dotenv';

export default async function globalTeardown() {
  dotenv.config({ path: path.join(__dirname, 'config', '.env.test.local') });

  const apiKey = process.env.PLAYWRIGHT_TEST_API_KEY;
  const testDataApiUrl =
    process.env.LOCAL_TEST_DATA_API_URL || 'http://localhost:3200';
  const appDomain = process.env.APP_DOMAIN || 'BRIDGE_EXPRESS_E2E_TEST';

  if (!apiKey) return;

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
        console.log(`[e2e/global-teardown] Purged ${count} test account(s).`);
      }
    }
  } catch {
    // Best-effort — don't fail teardown
  }
}
