import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createCreatorServices } from '../src/creator.js';
import { createQuotaStore, CreatorError } from '../src/quotas.js';
import { generateDemo } from '../src/generation.js';

const mongoUri = process.env.TEST_MONGODB_URI;
const token = 'ci-owner-setup-token-not-a-production-secret-123456789';
const serviceToken = 'ci-backend-service-token-not-production-123456789';
const origin = 'http://127.0.0.1:3000';
const credentials = { name: 'Test Creator', email: 'creator@example.test', password: 'Example-test-password-1234' };
const input = { requestId: 'request-a', generationMode: 'live', mode: 'create', prompt: 'Explain three cycling power zones.' };

async function fixture(t, overrides = {}) {
  const database = `endurance_canvas_test_${process.pid}_${randomBytes(6).toString('hex')}`;
  const config = { ...loadConfig({
    NODE_ENV: 'test', BACKEND_SERVICE_TOKEN: serviceToken, STUDIO_ORIGIN: origin,
    MONGODB_URI: mongoUri, MONGODB_DATABASE: database, AUTH_SECRET: randomBytes(48).toString('base64url'),
    OWNER_SETUP_TOKEN_HASH: createHash('sha256').update(token).digest('hex'),
    OWNER_SETUP_EXPIRES_AT: new Date(Date.now() + 3600000).toISOString(),
    AI_MODE: 'live', AI_MODEL_ID: 'test/fixture', AI_GATEWAY_API_KEY: 'fixture-only',
    AI_DAILY_REQUEST_LIMIT: '3', AI_MONTHLY_REQUEST_LIMIT: '10', GENERATION_MAX_PER_MINUTE: '120',
  }), ...overrides.config };
  const client = new MongoClient(mongoUri, { timeoutMS: 8000 });
  const creator = await createCreatorServices(config, { client });
  let calls = 0;
  const generator = overrides.generator || (async (body) => { calls += 1; return { ...generateDemo(body), usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 } }; });
  const server = createApp({ config, creator, generator }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await client.db(database).dropDatabase();
    await creator.close();
  });
  const request = (path, body, cookie, extraHeaders = {}) => fetch(`${url}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${serviceToken}`, Origin: config.studioOrigin, 'Content-Type': 'application/json', 'x-canvas-client-ip': '127.0.0.1', ...cookie ? { Cookie: cookie } : {}, ...extraHeaders },
    ...body !== undefined ? { body: JSON.stringify(body) } : {},
  });
  async function setup() { return request('/api/v1/creator/setup', { token, ...credentials }); }
  async function login(password = credentials.password) {
    const response = await request('/api/auth/sign-in/email', { email: credentials.email, password });
    assert.equal(response.status, 200, await response.clone().text());
    const setCookies = response.headers.getSetCookie();
    assert.ok(setCookies.some((value) => /HttpOnly/i.test(value)));
    assert.ok(setCookies.some((value) => /SameSite=Lax/i.test(value)));
    return setCookies.map((value) => value.split(';')[0]).join('; ');
  }
  return { config, client, db: client.db(database), creator, url, request, setup, login, calls: () => calls };
}

test('Mongo integration: owner setup, singleton race, session validation and revocation', { skip: !mongoUri, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const before = await f.request('/api/v1/creator').then((r) => r.json());
  assert.equal(before.auth.setupAvailable, true);
  assert.equal(before.auth.signedIn, false);
  assert.equal(before.ai.modelId, undefined);
  assert.equal(before.ai.limits, undefined);
  assert.equal((await f.request('/api/v1/creator/setup', { token: 'invalid'.repeat(10), ...credentials })).status, 403);
  assert.equal((await f.request('/api/v1/creator/setup', { token, ...credentials, password: 'short' })).status, 400);
  assert.equal((await f.request('/api/v1/creator').then((r) => r.json())).auth.setupAvailable, true);
  assert.equal((await f.request('/api/auth/sign-up/email', credentials)).status, 404);
  assert.equal((await f.request('/api/v1/creator/setup', { token, ...credentials }, undefined, { Origin: 'https://attacker.example' })).status, 403);

  const results = await Promise.all([
    f.request('/api/v1/creator/setup', { token, ...credentials }),
    f.request('/api/v1/creator/setup', { token, ...credentials, email: 'other@example.test' }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(await f.db.collection('user').countDocuments({ canvasOwner: 'owner' }), 1);
  assert.equal(await f.db.collection('account').countDocuments({ providerId: 'credential' }), 1);
  assert.equal(await f.db.collection('session').countDocuments({}), 0, 'setup must not auto sign in');
  assert.equal((await f.setup()).status, 409);
  assert.equal((await f.request('/api/v1/generations', input)).status, 401);
  assert.equal(f.calls(), 0);

  const owner = await f.db.collection('user').findOne({ canvasOwner: 'owner' });
  const signIn = await f.request('/api/auth/sign-in/email', { email: owner.email, password: credentials.password });
  assert.equal(signIn.status, 200, await signIn.clone().text());
  const cookie = signIn.headers.getSetCookie().map((value) => value.split(';')[0]).join('; ');
  assert.ok(cookie);
  const state = await f.request('/api/v1/creator', undefined, cookie).then((r) => r.json());
  assert.equal(state.auth.signedIn, true);
  assert.equal(state.auth.setupAvailable, false);
  assert.equal(state.ai.limits.daily.used, 0);
  assert.equal((await f.request('/api/v1/generations', input, cookie)).status, 200);
  assert.equal((await f.request('/api/auth/sign-out', {}, cookie)).status, 200);
  assert.equal((await f.request('/api/v1/generations', { ...input, requestId: 'after-signout' }, cookie)).status, 401);
  assert.equal(f.calls(), 1);
});

test('Mongo integration: quota reservations survive restart, reject duplicates and cap concurrent requests', { skip: !mongoUri, timeout: 30000 }, async (t) => {
  const f = await fixture(t, { config: { liveDailyLimit: 2, liveMonthlyLimit: 3 } });
  assert.equal((await f.setup()).status, 200);
  const cookie = await f.login();
  const first = await f.request('/api/v1/generations', input, cookie);
  assert.equal(first.status, 200);
  const duplicate = await f.request('/api/v1/generations', input, cookie);
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json()).error.code, 'DUPLICATE_REQUEST');
  const conflict = await f.request('/api/v1/generations', { ...input, prompt: 'Explain LT1 in detail.' }, cookie);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'REQUEST_ID_CONFLICT');
  assert.equal(f.calls(), 1);
  const owner = await f.creator.session({ cookie });
  const freshStore = createQuotaStore({ db: f.db, client: f.client, config: f.config });
  assert.equal((await freshStore.limits(owner.user.id)).daily.used, 1, 'new store reads persisted quota');
  const competing = await Promise.allSettled([
    freshStore.reserve(owner.user.id, 'race-a', input),
    freshStore.reserve(owner.user.id, 'race-b', input),
  ]);
  assert.equal(competing.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = competing.find((result) => result.status === 'rejected').reason;
  assert.ok(rejected instanceof CreatorError);
  assert.equal(rejected.code, 'QUOTA_EXCEEDED');
  assert.equal((await freshStore.limits(owner.user.id)).daily.used, 2);
  assert.equal((await freshStore.limits(owner.user.id)).monthly.used, 2);
  assert.equal((await f.request('/api/v1/generations', { ...input, requestId: 'after-limit' }, cookie)).status, 429);
  assert.equal((await f.request('/api/v1/generations', { ...input, generationMode: 'demo', requestId: 'free-demo' })).status, 200);
  assert.equal(f.calls(), 2, 'only first live plus free demo reached generator');
  const attempts = await f.db.collection('generationAttempts').find({}).toArray();
  assert.equal(attempts.length, 2);
  assert.equal(JSON.stringify(attempts).includes(input.prompt), false);
  assert.equal(attempts.some((attempt) => 'content' in attempt || 'prompt' in attempt), false);
});

test('Mongo integration: failed provider attempts count and changing password revokes other sessions', { skip: !mongoUri, timeout: 30000 }, async (t) => {
  const f = await fixture(t, { generator: async () => { throw new Error('private provider diagnostics'); } });
  assert.equal((await f.setup()).status, 200);
  const firstCookie = await f.login();
  const secondCookie = await f.login();
  const failed = await f.request('/api/v1/generations', input, firstCookie);
  assert.equal(failed.status, 502);
  assert.equal((await failed.text()).includes('private provider'), false);
  const state = await f.request('/api/v1/creator', undefined, firstCookie).then((r) => r.json());
  assert.equal(state.ai.limits.daily.used, 1);
  const changed = await f.request('/api/auth/change-password', { currentPassword: credentials.password, newPassword: 'A-new-test-password-5678', revokeOtherSessions: true }, firstCookie);
  assert.equal(changed.status, 200, await changed.clone().text());
  assert.equal((await f.request('/api/v1/creator', undefined, secondCookie).then((r) => r.json())).auth.signedIn, false);
});

test('Mongo integration: monthly limit applies after a UTC day rollover and resets next month', { skip: !mongoUri, timeout: 30000 }, async (t) => {
  const f = await fixture(t, { config: { liveDailyLimit: 2, liveMonthlyLimit: 2 } });
  let now = Date.parse('2026-11-29T12:00:00Z');
  const store = createQuotaStore({ db: f.db, client: f.client, config: f.config, clock: () => now });
  await store.reserve('quota-test-owner', 'month-one', input);
  now = Date.parse('2026-11-30T12:00:00Z');
  await store.reserve('quota-test-owner', 'month-two', input);
  await assert.rejects(store.reserve('quota-test-owner', 'month-blocked', input), { code: 'QUOTA_EXCEEDED' });
  assert.equal((await store.limits('quota-test-owner')).daily.used, 1);
  now = Date.parse('2026-12-01T00:00:00Z');
  await store.reserve('quota-test-owner', 'new-month', input);
  const limits = await store.limits('quota-test-owner');
  assert.equal(limits.daily.used, 1);
  assert.equal(limits.monthly.used, 1);
});

test('Mongo integration: concurrent duplicate identifiers reserve only one attempt', { skip: !mongoUri, timeout: 30000 }, async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    f.creator.quota.reserve('owner-idempotency', 'identical-request', input),
    f.creator.quota.reserve('owner-idempotency', 'identical-request', input),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'DUPLICATE_REQUEST');
  assert.equal((await f.creator.quota.limits('owner-idempotency')).daily.used, 1);
  assert.equal((await f.creator.quota.limits('owner-idempotency')).monthly.used, 1);
});

test('Mongo integration: cancelling a started generation consumes its allowance and records cancellation', { skip: !mongoUri, timeout: 30000 }, async (t) => {
  let started;
  const startedPromise = new Promise((resolve) => { started = resolve; });
  const f = await fixture(t, { generator: async (_body, _config, signal) => {
    started();
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
  } });
  assert.equal((await f.setup()).status, 200);
  const cookie = await f.login();
  const controller = new AbortController();
  const pending = fetch(`${f.url}/api/v1/generations`, {
    method: 'POST', headers: { Authorization: `Bearer ${serviceToken}`, Origin: origin, 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...input, requestId: 'cancelled-request' }), signal: controller.signal,
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await startedPromise;
  controller.abort();
  await rejected;
  let attempt;
  for (let tries = 0; tries < 50; tries += 1) {
    attempt = await f.db.collection('generationAttempts').findOne({ requestId: 'cancelled-request' });
    if (attempt?.status === 'cancelled') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(attempt.status, 'cancelled');
  const state = await f.request('/api/v1/creator', undefined, cookie).then((r) => r.json());
  assert.equal(state.ai.limits.daily.used, 1);
});

test('Mongo integration: production sign-in sets Secure HttpOnly host-only SameSite cookies', { skip: !mongoUri, timeout: 30000 }, async (t) => {
  const f = await fixture(t, { config: { production: true, studioOrigin: 'https://creator.example.test' } });
  const setup = await f.setup();
  assert.equal(setup.status, 200, await setup.clone().text());
  const response = await f.request('/api/auth/sign-in/email', { email: credentials.email, password: credentials.password });
  assert.equal(response.status, 200, await response.clone().text());
  const cookies = response.headers.getSetCookie();
  const sessionCookie = cookies.find((value) => value.includes('.session_token='));
  assert.ok(sessionCookie, 'session cookie is present');
  assert.match(sessionCookie, /;\s*Secure(?:;|$)/i);
  assert.match(sessionCookie, /;\s*HttpOnly(?:;|$)/i);
  assert.match(sessionCookie, /;\s*SameSite=Lax(?:;|$)/i);
  assert.equal(cookies.some((value) => /;\s*Domain=/i.test(value)), false);
  const cookie = cookies.map((value) => value.split(';')[0]).join('; ');
  const state = await f.request('/api/v1/creator', undefined, cookie).then((r) => r.json());
  assert.equal(state.auth.signedIn, true);
});
