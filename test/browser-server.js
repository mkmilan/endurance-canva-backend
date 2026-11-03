// Browser-test fixture only. It never contacts an AI provider.
import { createHash, randomBytes } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createCreatorServices, mongoClientOptions } from '../src/creator.js';
import { generateDemo, example } from '../src/generation.js';

if (process.env.NODE_ENV === 'production') throw new Error('The browser fixture cannot run in production.');
if (!process.env.TEST_MONGODB_URI) throw new Error('TEST_MONGODB_URI must point to a test replica set.');
const setupToken = process.env.CANVAS_TEST_SETUP_TOKEN || '';
if (setupToken.length < 32) throw new Error('CANVAS_TEST_SETUP_TOKEN must contain at least 32 characters.');
const database = `endurance_canvas_browser_${process.pid}_${randomBytes(3).toString('hex')}`;
const config = loadConfig({
  NODE_ENV: 'test',
  HOST: '127.0.0.1',
  PORT: process.env.PORT || '4000',
  BACKEND_SERVICE_TOKEN: process.env.BACKEND_SERVICE_TOKEN || '',
  STUDIO_ORIGIN: process.env.STUDIO_ORIGIN || 'http://127.0.0.1:3000',
  MONGODB_URI: process.env.TEST_MONGODB_URI,
  MONGODB_DATABASE: database,
  AUTH_SECRET: randomBytes(48).toString('base64url'),
  OWNER_SETUP_TOKEN_HASH: createHash('sha256').update(setupToken).digest('hex'),
  OWNER_SETUP_EXPIRES_AT: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  AI_MODE: 'live',
  AI_MODEL_ID: 'test/deterministic-fixture',
  AI_GATEWAY_API_KEY: 'test-fixture-never-sent',
  AI_DAILY_REQUEST_LIMIT: '3',
  AI_MONTHLY_REQUEST_LIMIT: '10',
  GENERATION_MAX_PER_MINUTE: '120',
});
const client = new MongoClient(config.mongoUri, mongoClientOptions(config));
const creator = await createCreatorServices(config, { client });
const generator = async (input, effectiveConfig) => {
  if (effectiveConfig.mode === 'live') return {
    status: 'ok',
    content: { ...structuredClone(example), title: 'AI test fixture lesson' },
    message: 'AI test fixture (no model request).',
    usage: { inputTokens: 100, outputTokens: 100, totalTokens: 200 },
  };
  return generateDemo(input);
};
const server = createApp({ config, creator, generator }).listen(config.port, config.host, () => {
  console.log(JSON.stringify({ event: 'browser_fixture_listening', port: config.port, aiProviderCalls: false }));
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(async () => {
    await client.db(database).dropDatabase().catch(() => {});
    await creator.close();
    process.exit(0);
  });
  setTimeout(() => { server.closeAllConnections(); }, 1000).unref();
  setTimeout(() => process.exit(1), 5000).unref();
}
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
