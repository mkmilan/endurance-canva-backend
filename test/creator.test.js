import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { createCreatorServices, validSetupToken, isAllowedAuthRoute, providerConfigured } from '../src/creator.js';
import { quotaPeriods, generationInputHash } from '../src/quotas.js';

test('owner setup tokens are bounded, hashed and expire at the configured instant', () => {
  const token = 'test-setup-token-that-is-long-enough-for-validation';
  const config = { setupTokenHash: createHash('sha256').update(token).digest('hex'), setupExpiresAt: 2000 };
  assert.equal(validSetupToken(token, config, 1999), true);
  assert.equal(validSetupToken(token, config, 2000), false);
  assert.equal(validSetupToken('x'.repeat(64), config, 1000), false);
  assert.equal(validSetupToken(undefined, config, 1000), false);
  assert.equal(validSetupToken('x'.repeat(257), config, 1000), false);
  assert.equal(validSetupToken(token, { ...config, setupTokenHash: '' }, 1000), false);
});

test('creator settings fail closed and production uses an exact secure origin', async () => {
  assert.equal(await createCreatorServices(loadConfig({})), null);
  assert.equal(loadConfig({ MONGODB_URI: 'mongodb://localhost', AUTH_SECRET: 'short', STUDIO_ORIGIN: 'http://localhost:3000' }).authConfigured, false);
  assert.throws(() => loadConfig({ STUDIO_ORIGIN: 'https://studio.example/path' }), /STUDIO_ORIGIN/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', BACKEND_SERVICE_TOKEN: 'a'.repeat(48), STUDIO_ORIGIN: 'http://studio.example' }), /STUDIO_ORIGIN/);
  assert.equal(providerConfigured(loadConfig({ AI_MODE: 'live' })), false);
  assert.equal(providerConfigured(loadConfig({ AI_MODE: 'live', AI_MODEL_ID: 'test/model', AI_GATEWAY_API_KEY: 'test' })), true);
});

test('auth HTTP routes expose only the supported method and exact path', () => {
  assert.equal(isAllowedAuthRoute('/sign-in/email', 'POST'), true);
  assert.equal(isAllowedAuthRoute('/get-session', 'GET'), true);
  assert.equal(isAllowedAuthRoute('/get-session', 'POST'), false);
  assert.equal(isAllowedAuthRoute('/sign-in/email/', 'POST'), false);
  assert.equal(isAllowedAuthRoute('/sign-up/email', 'POST'), false);
});

test('UTC quotas roll over correctly at month/year boundaries and leap day', () => {
  const year = quotaPeriods(Date.parse('2026-12-31T23:59:59Z'));
  assert.equal(year.daily.resetsAt.toISOString(), '2027-01-01T00:00:00.000Z');
  assert.equal(year.monthly.resetsAt.toISOString(), '2027-01-01T00:00:00.000Z');
  const leap = quotaPeriods(Date.parse('2028-02-28T23:59:59Z'));
  assert.equal(leap.daily.resetsAt.toISOString(), '2028-02-29T00:00:00.000Z');
  assert.equal(leap.monthly.resetsAt.toISOString(), '2028-03-01T00:00:00.000Z');
});

test('generation fingerprints contain no raw prompt and distinguish different work', () => {
  const base = { requestId: 'one', generationMode: 'live', mode: 'create', prompt: 'A private teaching idea' };
  const fingerprint = generationInputHash(base);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(fingerprint, generationInputHash({ ...base, requestId: 'two' }));
  assert.notEqual(fingerprint, generationInputHash({ ...base, prompt: 'A different teaching idea' }));
});
