import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { example, generateDemo } from '../src/generation.js';

const testToken = 'a'.repeat(48);
async function server(t, overrides = {}) {
  const config = { ...loadConfig({}), serviceToken: testToken, maxPerMinute: 100, ...overrides.config };
  const instance = createApp({ config, generator: overrides.generator, clock: overrides.clock }).listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const url = `http://127.0.0.1:${instance.address().port}`;
  const request = (body, extra = {}) => fetch(`${url}/api/v1/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${testToken}`, ...extra.headers }, body: JSON.stringify(body) });
  return { url, request };
}
const createInput = { requestId: 'request-1', mode: 'create', prompt: 'Explain three training zones to a beginner cyclist.' };

test('production fails closed when the service token is absent or weak', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /BACKEND_SERVICE_TOKEN/);
  assert.throws(() => loadConfig({ NODE_ENV: 'production', BACKEND_SERVICE_TOKEN: 'short' }), /BACKEND_SERVICE_TOKEN/);
  assert.equal(loadConfig({ NODE_ENV: 'production', BACKEND_SERVICE_TOKEN: testToken }).host, '0.0.0.0');
  assert.throws(() => loadConfig({ AI_MODE: 'live' }), /AI_MODEL_ID/);
});

test('health is public and catalogue/generation require authentication', async (t) => {
  const { url } = await server(t);
  const health = await fetch(`${url}/health`).then((r) => r.json());
  assert.equal(health.status, 'ok');
  assert.equal(health.mode, 'demo');
  assert.equal(JSON.stringify(health).includes(testToken), false);
  assert.equal((await fetch(`${url}/api/v1/catalog`)).status, 401);
  assert.equal((await fetch(`${url}/api/v1/generations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(createInput) })).status, 401);
});

test('catalogue returns exact evidence version and refuses unknown versions', async (t) => {
  const { url } = await server(t);
  const options = { headers: { Authorization: `Bearer ${testToken}` } };
  const response = await fetch(`${url}/api/v1/catalog?version=1`, options);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.catalogVersion, 1);
  assert.match(body.sources[0].limitations, /ventilatory/);
  assert.equal((await fetch(`${url}/api/v1/catalog?version=999`, options)).status, 404);
});

test('create and refine return labelled validated candidates without mutating prior content', async (t) => {
  const { request } = await server(t);
  const response = await request(createInput);
  const initial = await response.json();
  assert.equal(response.status, 200);
  assert.equal(initial.status, 'ok');
  assert.equal(initial.mode, 'demo');
  assert.match(initial.message, /Guided demo/);
  assert.equal(initial.requestId, 'request-1');
  const preserved = structuredClone(initial.content);
  const refined = await request({ requestId: 'request-2', mode: 'refine', prompt: 'Add more detail and use a blue accent.', currentContent: initial.content, baseRevision: 3 }).then((r) => r.json());
  assert.equal(refined.baseRevision, 3);
  assert.equal(refined.content.presentation.accent, 'blue');
  assert.equal(refined.content.audience, 'intermediate');
  assert.notDeepEqual(refined.content.blocks, initial.content.blocks);
  assert.deepEqual(initial.content, preserved);
});

test('unsupported questions do not return a substitute lesson', async (t) => {
  const { request } = await server(t);
  const result = await request({ ...createInput, prompt: 'What is the weather in Brussels?' }).then((r) => r.json());
  assert.equal(result.status, 'unsupported');
  assert.equal(result.content, undefined);
  const injury = await request({ ...createInput, prompt: 'Diagnose an injury using LT1.' }).then((r) => r.json());
  assert.equal(injury.status, 'unsupported');
});

test('invalid or executable imported content cannot be refined', async (t) => {
  const { request } = await server(t);
  const content = { ...structuredClone(example), script: 'runSomething()' };
  const response = await request({ mode: 'refine', prompt: 'Make it simpler', currentContent: content });
  assert.equal(response.status, 422);
  assert.equal((await response.json()).error.code, 'INVALID_LESSON');
});

test('requests are bounded and unknown fields are rejected', async (t) => {
  const { request } = await server(t);
  assert.equal((await request({ ...createInput, prompt: 'x'.repeat(4001) })).status, 400);
  assert.equal((await request({ ...createInput, overrideSystem: true })).status, 400);
  assert.equal((await request({ ...createInput, prompt: 'x'.repeat(40000) })).status, 413);
  assert.equal((await request({ ...createInput, requestId: '<script>' })).status, 400);
});

test('invalid generated content is not returned as a successful lesson', async (t) => {
  const { request } = await server(t, { generator: async () => ({ status: 'ok', content: { ...example, owner: 'someone' } }) });
  const response = await request(createInput);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'INVALID_GENERATION');
});

test('provider errors do not disclose internal values', async (t) => {
  const { request } = await server(t, { generator: async () => { throw new Error('sensitive-value-from-provider'); } });
  const response = await request(createInput);
  assert.equal(response.status, 502);
  assert.equal((await response.text()).includes('sensitive-value-from-provider'), false);
});

test('timeout preserves a recoverable error and releases the request slot', async (t) => {
  const { request } = await server(t, { config: { timeoutMs: 15 }, generator: () => new Promise(() => {}) });
  const response = await request(createInput);
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'GENERATION_TIMEOUT');
});

test('rate limiting caps generation attempts', async (t) => {
  const { request } = await server(t, { config: { maxPerMinute: 1 } });
  assert.equal((await request(createInput)).status, 200);
  const response = await request(createInput);
  assert.equal(response.status, 429);
  assert.ok(response.headers.get('Retry-After'));
});

test('guided examples change intended defaults and reject invalid threshold edits', () => {
  const original = structuredClone(example);
  assert.ok(generateDemo({ mode: 'refine', prompt: 'Show an example above LT2', currentContent: example }).content.visual.defaultPower > 240);
  assert.equal(generateDemo({ mode: 'refine', prompt: 'Set power to 220 W', currentContent: example }).content.visual.defaultPower, 220);
  assert.equal(generateDemo({ mode: 'refine', prompt: 'Set LT1 to 300 W', currentContent: example }).status, 'invalid');
  assert.deepEqual(example, original);
});
