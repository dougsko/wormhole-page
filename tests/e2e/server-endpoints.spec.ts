import { test, expect } from '@playwright/test';

test.describe('Server endpoints', () => {
  test('GET /health returns 200 with body "ok"', async ({ request }) => {
    const response = await request.get('/health');
    expect(response.status()).toBe(200);
    expect(await response.text()).toBe('ok');
  });

  test('unknown routes return 404', async ({ request }) => {
    const response = await request.get('/this-route-does-not-exist');
    expect(response.status()).toBe(404);
  });

  test('GET /sw.js returns JavaScript with no-cache header', async ({ request }) => {
    const response = await request.get('/sw.js');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/javascript');
    expect(response.headers()['cache-control']).toContain('no-cache');
  });

  test('GET /version returns the build identifier', async ({ request }) => {
    const response = await request.get('/version');
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('text/plain');
    expect(await response.text()).toMatch(/^wormhole-page \S+\n?$/);
  });

  test('GET /config.js exposes the build version', async ({ request }) => {
    const response = await request.get('/config.js');
    expect(response.status()).toBe(200);
    const body = await response.text();
    expect(body).toContain('"version"');
    expect(body).toMatch(/"version":"[^"]+"/);
  });
});
