import test from 'node:test';
import assert from 'node:assert/strict';
import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { example, generateDemo, generateLive, generateLesson, GenerationError } from '../src/generation.js';

const config = { mode: 'live', modelId: 'google/gemini-3.5-flash-lite', gatewayKey: 'unused-test-key', maxOutputTokens: 2500 };
const createInput = { mode: 'create', prompt: 'Explain the three-zone example to a new cyclist.' };
const rawUsage = {
  inputTokens: { total: 321, noCache: 300, cacheRead: 21, cacheWrite: undefined },
  outputTokens: { total: 123, text: 100, reasoning: 23 }
};

function modelFor(value, overrides = {}) {
  return new MockLanguageModelV4({
    modelId: config.modelId,
    doGenerate: {
      content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
      finishReason: { unified: 'stop', raw: 'STOP' },
      usage: structuredClone(rawUsage),
      warnings: [],
      providerMetadata: { gateway: { generationId: 'gen_test-123', secret: 'provider-private-data' }, google: { private: 'provider-private-data' } },
      response: { id: 'upstream-private-id', modelId: 'provider-private-model', timestamp: new Date('2026-11-03T00:00:00Z'), body: { private: 'provider-private-data' } },
      ...overrides
    }
  });
}

const successfulOutput = () => ({ status: 'ok', content: structuredClone(example) });

test('live uses actual SDK structured output and returns only bounded usage metadata', async () => {
  const output = successfulOutput();
  const model = modelFor(output);
  const result = await generateLive(createInput, config, undefined, { model });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.content, example);
  assert.deepEqual(result.usage, { inputTokens: 321, outputTokens: 123, totalTokens: 444, modelId: config.modelId, generationId: 'gen_test-123' });
  assert.equal(JSON.stringify(result).includes('provider-private'), false);
  assert.equal(model.doGenerateCalls.length, 1);
  const call = model.doGenerateCalls[0];
  assert.equal(call.maxOutputTokens, config.maxOutputTokens);
  assert.equal(call.responseFormat.type, 'json');
  assert.deepEqual(call.responseFormat.schema.required, ['status', 'content']);
  assert.deepEqual(call.responseFormat.schema.properties.status.enum, ['ok', 'unsupported']);
  assert.equal(call.tools, undefined);
});

test('natural refinements reach the model without demo keyword gating and preserve input', async () => {
  const original = structuredClone(example);
  const currentContent = structuredClone(example);
  const revised = structuredClone(example);
  revised.title = 'Picture three rooms and two doors';
  const prompt = 'Make the opening more inviting. Use three rooms and two doors as an analogy, keeping the numbers.';
  const model = modelFor({ status: 'ok', content: revised });
  assert.equal(generateDemo({ mode: 'refine', prompt, currentContent }).status, 'unsupported');
  const result = await generateLesson({ mode: 'refine', prompt, currentContent }, config, undefined, { model });
  assert.equal(result.content.title, revised.title);
  assert.deepEqual(currentContent, original);
  assert.equal(model.doGenerateCalls.length, 1);
  const messages = model.doGenerateCalls[0].prompt;
  const userMessage = messages.find((message) => message.role === 'user');
  const request = JSON.parse(userMessage.content.find((part) => part.type === 'text').text);
  assert.equal(request.request, prompt);
  assert.deepEqual(request.currentContent, original);
  assert.match(messages.find((message) => message.role === 'system').content, /ventilatory thresholds/);
});

test('unsupported structured output contains no substitute lesson and keeps the current draft intact', async () => {
  const currentContent = structuredClone(example);
  const before = structuredClone(currentContent);
  const model = modelFor({ status: 'unsupported', content: null });
  const result = await generateLive({ mode: 'refine', prompt: 'Replace this with a lactate curve.', currentContent }, config, undefined, { model });
  assert.equal(result.status, 'unsupported');
  assert.equal(Object.hasOwn(result, 'content'), false);
  assert.deepEqual(result.supportedLessonTypes, ['three-zone-explainer']);
  assert.deepEqual(currentContent, before);
  assert.equal(result.usage.totalTokens, 444);
});

const invalidOutputs = [
  ['out-of-order thresholds', (value) => { value.content.visual.lt1 = value.content.visual.lt2; }],
  ['out-of-domain power', (value) => { value.content.visual.defaultPower = 900; }],
  ['unknown source', (value) => { value.content.sourceIds = ['invented-study']; }],
  ['research claim without its source', (value) => { value.content.blocks[0].claimIds = ['three-zone-framework']; value.content.sourceIds = []; }],
  ['unknown lesson field', (value) => { value.content.reviewed = true; }],
  ['executable HTML', (value) => { value.content.blocks[0].text = '<script>alert(1)</script>'; }],
  ['ok without content', (value) => { value.content = null; }],
  ['unsupported with content', (value) => { value.status = 'unsupported'; }],
  ['unknown status', (value) => { value.status = 'published'; }],
  ['unexpected envelope field', (value) => { value.secret = 'provider-private-data'; }]
];
for (const [name, change] of invalidOutputs) {
  test(`live rejects ${name} without leaking raw model output`, async () => {
    const value = successfulOutput();
    change(value);
    const model = modelFor(value);
    await assert.rejects(generateLive(createInput, config, undefined, { model }), (error) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.code, 'INVALID_GENERATION');
      assert.equal(error.httpStatus, 502);
      assert.equal(error.usage.totalTokens, 444);
      assert.equal(Object.hasOwn(error, 'cause'), false);
      assert.equal(Object.hasOwn(error, 'text'), false);
      assert.equal(Object.hasOwn(error, 'response'), false);
      assert.equal(JSON.stringify(error).includes('provider-private'), false);
      return true;
    });
    assert.equal(model.doGenerateCalls.length, 1);
  });
}

test('non-finite JSON numbers and malformed JSON are rejected by actual SDK parsing/validation', async () => {
  const nonFinite = JSON.stringify(successfulOutput()).replace('"lt1":180', '"lt1":1e400');
  for (const output of [nonFinite, '{"status":"ok","content":']) {
    const model = modelFor(output);
    await assert.rejects(generateLive(createInput, config, undefined, { model }), { code: 'INVALID_GENERATION', httpStatus: 502 });
    assert.equal(model.doGenerateCalls.length, 1);
  }
});

test('missing and malformed usage stays unknown and arbitrary metadata never passes through', async () => {
  const model = modelFor(successfulOutput(), {
    usage: { inputTokens: { total: undefined }, outputTokens: { total: -10 }, raw: { secret: 'provider-private-data' } },
    providerMetadata: { gateway: { generationId: 'bad\nprovider-private-data', other: 'provider-private-data' } }
  });
  const result = await generateLive(createInput, config, undefined, { model });
  assert.deepEqual(result.usage, { inputTokens: null, outputTokens: null, totalTokens: null, modelId: config.modelId });
  assert.equal(JSON.stringify(result).includes('provider-private-data'), false);
});

test('provider failures map to fixed public errors with no raw secrets and no SDK retries', async () => {
  for (const [statusCode, code, httpStatus] of [
    [401, 'AI_AUTHENTICATION_FAILED', 503],
    [402, 'AI_CREDITS_UNAVAILABLE', 503],
    [403, 'AI_ACCESS_DENIED', 503],
    [429, 'AI_RATE_LIMITED', 429],
    [503, 'AI_UNAVAILABLE', 503],
    [504, 'GENERATION_TIMEOUT', 504],
    [418, 'GENERATION_FAILED', 502]
  ]) {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new APICallError({
          message: 'provider-private-key do not expose',
          url: 'https://upstream.invalid?secret=provider-private-key',
          requestBodyValues: { prompt: 'private full prompt' },
          responseBody: 'provider-private-key',
          statusCode,
          isRetryable: true
        });
      }
    });
    await assert.rejects(generateLive(createInput, config, undefined, { model }), (error) => {
      assert.ok(error instanceof GenerationError);
      assert.equal(error.code, code);
      assert.equal(error.httpStatus, httpStatus);
      assert.equal(error.cause, undefined);
      assert.equal(JSON.stringify(error).includes('private'), false);
      assert.equal(error.stack.includes('provider-private-key'), false);
      return true;
    });
    assert.equal(model.doGenerateCalls.length, 1, `HTTP ${statusCode} must not retry`);
  }
});

test('an abort reaches the model and returns a safe timeout without another call', async () => {
  const controller = new AbortController();
  let observedAbort = false;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ abortSignal }) => new Promise((resolve, reject) => {
      abortSignal.addEventListener('abort', () => {
        observedAbort = true;
        reject(new DOMException('private provider cancellation detail', 'AbortError'));
      }, { once: true });
      controller.abort();
    })
  });
  await assert.rejects(generateLive(createInput, config, controller.signal, { model }), { code: 'GENERATION_TIMEOUT', httpStatus: 504 });
  assert.equal(observedAbort, true);
  assert.equal(model.doGenerateCalls.length, 1);
});

test('empty model output fails closed rather than replacing the current lesson', async () => {
  const model = modelFor(successfulOutput(), { content: [], finishReason: { unified: 'length', raw: 'MAX_TOKENS' } });
  await assert.rejects(generateLive(createInput, config, undefined, { model }), { code: 'INVALID_GENERATION', httpStatus: 502 });
});

test('demo dispatch never invokes an injected live model', async () => {
  const model = new MockLanguageModelV4();
  const result = await generateLesson(createInput, { ...config, mode: 'demo' }, undefined, { model });
  assert.equal(result.status, 'ok');
  assert.match(result.message, /Guided demo/);
  assert.equal(model.doGenerateCalls.length, 0);
});
