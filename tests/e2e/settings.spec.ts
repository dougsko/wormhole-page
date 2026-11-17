import { test, expect } from '@playwright/test';

test.use({ serviceWorkers: 'block' });

// Serve a deployment-configured /config.js (public as the operator default,
// the way dougsko.com is deployed) without needing server env vars.
async function mockDeploymentConfig(page: import('@playwright/test').Page) {
  await page.route('**/config.js*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: 'window.WORMHOLE_CONFIG = ' + JSON.stringify({
        mailboxUrl: 'wss://mailbox.example.com/v1',
        transitUrl: '',
        transitTcpHint: 'tcp://transit.example.com:4001',
        profileName: 'example.com',
        defaultProfile: 'public',
        version: 'test',
      }) + ';\n',
    }),
  );
}

async function openCustom(page: import('@playwright/test').Page) {
  await page.click('#settings-toggle');
  await page.selectOption('#settings-profile', 'custom');
}

test.describe('Settings modal', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.removeItem('wormhole-settings'));
    await page.reload();
  });

  test('gear button opens the dialog, ESC closes it', async ({ page }) => {
    await page.click('#settings-toggle');
    await expect(page.locator('#settings-modal')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#settings-overlay')).toHaveClass(/hidden/);
  });

  test('defaults to the Public profile (deployment configured)', async ({ page }) => {
    await mockDeploymentConfig(page);
    await page.reload();
    await page.click('#settings-toggle');
    await expect(page.locator('#settings-profile')).toHaveValue('public');
    await expect(page.locator('#settings-active-summary')).toContainText('Standard public servers');
    // the deployment profile is still offered as the alternative
    await expect(page.locator('#settings-profile option[value="deployment"]')).toHaveCount(1);
  });

  test('defaults to the Public profile with custom rows hidden', async ({ page }) => {
    await page.click('#settings-toggle');
    await expect(page.locator('#settings-profile')).toHaveValue('public');
    await expect(page.locator('#settings-active-summary')).toContainText('Standard public servers');
    await expect(page.locator('#settings-custom-rows')).toHaveClass(/hidden/);
    await expect(page.locator('#settings-active-summary')).toBeVisible();
    await expect(page.locator('#settings-dot')).toBeHidden();
  });

  test('deployment profile is offered and persists across reload', async ({ page }) => {
    await mockDeploymentConfig(page);
    await page.reload();
    await page.click('#settings-toggle');
    await page.selectOption('#settings-profile', 'deployment');
    await expect(page.locator('#settings-active-summary')).toContainText('example.com');
    await page.click('#settings-save');
    expect(await page.evaluate(() => localStorage.getItem('wormhole-settings'))).toBe(
      JSON.stringify({ profile: 'deployment' }),
    );
    await expect(page.locator('#settings-overlay')).toHaveClass(/hidden/);
    await page.reload();
    await expect(page.locator('#settings-dot')).toBeVisible();
    await page.click('#settings-toggle');
    await expect(page.locator('#settings-profile')).toHaveValue('deployment');
  });

  test('cancel closes without saving', async ({ page }) => {
    await openCustom(page);
    await page.fill('#settings-mailbox-url', 'wss://mailbox.example.com/v1');
    await page.click('#settings-cancel');
    await expect(page.locator('#settings-overlay')).toHaveClass(/hidden/);
    expect(await page.evaluate(() => localStorage.getItem('wormhole-settings'))).toBeNull();
  });

  test('rejects non-ws(s) URLs and does not persist', async ({ page }) => {
    await openCustom(page);
    await page.fill('#settings-mailbox-url', 'https://mailbox.example.com/v1');
    await page.click('#settings-save');
    await expect(page.locator('#settings-error')).toBeVisible();
    await expect(page.locator('#settings-modal')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('wormhole-settings'))).toBeNull();
  });

  test('rejects malformed URLs', async ({ page }) => {
    await openCustom(page);
    await page.fill('#settings-transit-url', 'not a url');
    await page.click('#settings-save');
    await expect(page.locator('#settings-error')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('wormhole-settings'))).toBeNull();
  });

  test('rejects a TCP hint without the tcp:// scheme', async ({ page }) => {
    await openCustom(page);
    await page.fill('#settings-transit-hint', 'https://transit.example.com:4001');
    await page.click('#settings-save');
    await expect(page.locator('#settings-error')).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem('wormhole-settings'))).toBeNull();
  });

  test('saves custom relays, shows dot, persists across reload', async ({ page }) => {
    await openCustom(page);
    await page.fill('#settings-mailbox-url', 'wss://mailbox.example.com/v1');
    await page.fill('#settings-transit-url', 'wss://transit.example.com/transit');
    await page.click('#settings-save');
    await expect(page.locator('#settings-overlay')).toHaveClass(/hidden/);

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wormhole-settings')!));
    expect(stored).toEqual({
      profile: 'custom',
      mailboxUrl: 'wss://mailbox.example.com/v1',
      transitRelayUrl: 'wss://transit.example.com/transit',
    });
    await expect(page.locator('#settings-dot')).toBeVisible();

    await page.reload();
    await expect(page.locator('#settings-dot')).toBeVisible();
    await page.click('#settings-toggle');
    await expect(page.locator('#settings-profile')).toHaveValue('custom');
    await expect(page.locator('#settings-mailbox-url')).toHaveValue('wss://mailbox.example.com/v1');
    await expect(page.locator('#settings-transit-url')).toHaveValue('wss://transit.example.com/transit');
  });

  test('switching back to the public (default) profile clears stored overrides', async ({ page }) => {
    await page.evaluate(() =>
      localStorage.setItem('wormhole-settings', JSON.stringify({ profile: 'custom', mailboxUrl: 'wss://mailbox.example.com/v1' })),
    );
    await page.reload();
    await page.click('#settings-toggle');
    await page.selectOption('#settings-profile', 'public');
    await page.click('#settings-save');
    expect(await page.evaluate(() => localStorage.getItem('wormhole-settings'))).toBeNull();
    await expect(page.locator('#settings-dot')).toBeHidden();
  });

  test('v1 stored settings are treated as custom', async ({ page }) => {
    await page.evaluate(() =>
      localStorage.setItem('wormhole-settings', JSON.stringify({ mailboxUrl: 'wss://mailbox.example.com/v1' })),
    );
    await page.reload();
    await expect(page.locator('#settings-dot')).toBeVisible();
    await page.click('#settings-toggle');
    await expect(page.locator('#settings-profile')).toHaveValue('custom');
    await expect(page.locator('#settings-mailbox-url')).toHaveValue('wss://mailbox.example.com/v1');
  });

  test('ws:// scheme is accepted', async ({ page }) => {
    await openCustom(page);
    await page.fill('#settings-transit-url', 'ws://relay.lan:4001/transit');
    await page.click('#settings-save');
    await expect(page.locator('#settings-error')).toBeHidden();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('wormhole-settings')!));
    expect(stored.transitRelayUrl).toBe('ws://relay.lan:4001/transit');
  });

  test('reset to defaults clears stored settings and hides dot', async ({ page }) => {
    await page.evaluate(() =>
      localStorage.setItem('wormhole-settings', JSON.stringify({ profile: 'custom', mailboxUrl: 'wss://mailbox.example.com/v1' })),
    );
    await page.reload();
    await page.click('#settings-toggle');
    await page.click('#settings-reset');
    await expect(page.locator('#settings-profile')).toHaveValue('public');
    expect(await page.evaluate(() => localStorage.getItem('wormhole-settings'))).toBeNull();
    await expect(page.locator('#settings-dot')).toBeHidden();
  });

  test('test connection reports failure for an unreachable relay', async ({ page }) => {
    await openCustom(page);
    await page.fill('#settings-mailbox-url', 'ws://127.0.0.1:1/unreachable');
    await page.click('#settings-test');
    await expect(page.locator('#settings-test-result')).toHaveClass(/err/, { timeout: 10000 });
  });

  test('test connection succeeds against a reachable WebSocket server', async ({ page }) => {
    const base = new URL(page.url());
    const wsUrl = (base.protocol === 'https:' ? 'wss://' : 'ws://') + base.host + '/transit';
    await openCustom(page);
    await page.fill('#settings-mailbox-url', wsUrl);
    await page.click('#settings-test');
    await expect(page.locator('#settings-test-result')).toHaveClass(/ok/, { timeout: 10000 });
  });
});
