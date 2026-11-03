function integer(value, fallback, min, max, name) {
  if (value === undefined || value === '') return fallback;
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${name} must be between ${min} and ${max}.`);
  return result;
}

export function loadConfig(env = process.env) {
  const production = env.NODE_ENV === 'production';
  const mode = env.AI_MODE || 'demo';
  if (!['demo', 'live'].includes(mode)) throw new Error('AI_MODE must be demo or live.');
  const serviceToken = env.BACKEND_SERVICE_TOKEN || '';
  if (production && serviceToken.length < 32) throw new Error('Production requires a BACKEND_SERVICE_TOKEN of at least 32 characters.');
  const studioOrigin = env.STUDIO_ORIGIN || '';
  if (studioOrigin) {
    let url;
    try { url = new URL(studioOrigin); } catch { throw new Error('STUDIO_ORIGIN must be an absolute origin.'); }
    if (url.origin !== studioOrigin || !['http:', 'https:'].includes(url.protocol) || (production && url.protocol !== 'https:')) throw new Error('STUDIO_ORIGIN must be an exact HTTPS origin in production.');
  }
  const authSecret = env.AUTH_SECRET || '';
  const mongoUri = env.MONGODB_URI || '';
  const setupTokenHash = env.OWNER_SETUP_TOKEN_HASH || '';
  const setupExpiresAt = Date.parse(env.OWNER_SETUP_EXPIRES_AT || '');
  return {
    production, mode, serviceToken,
    port: integer(env.PORT, 4000, 1, 65535, 'PORT'),
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    timeoutMs: integer(env.GENERATION_TIMEOUT_MS, 25000, 100, 55000, 'GENERATION_TIMEOUT_MS'),
    maxPerMinute: integer(env.GENERATION_MAX_PER_MINUTE, 12, 1, 120, 'GENERATION_MAX_PER_MINUTE'),
    maxConcurrent: integer(env.GENERATION_MAX_CONCURRENT, 2, 1, 5, 'GENERATION_MAX_CONCURRENT'),
    maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, 2500, 500, 6000, 'AI_MAX_OUTPUT_TOKENS'),
    modelId: env.AI_MODEL_ID || '',
    gatewayKey: env.AI_GATEWAY_API_KEY || '',
    studioOrigin, authSecret, mongoUri,
    mongoDatabase: env.MONGODB_DATABASE || 'endurance_canvas',
    mongoTimeoutMs: integer(env.MONGODB_TIMEOUT_MS, 8000, 100, 30000, 'MONGODB_TIMEOUT_MS'),
    authConfigured: Boolean(mongoUri && authSecret.length >= 32 && studioOrigin),
    setupTokenHash: /^[a-f0-9]{64}$/i.test(setupTokenHash) ? setupTokenHash.toLowerCase() : '',
    setupExpiresAt: Number.isFinite(setupExpiresAt) ? setupExpiresAt : 0,
    liveDailyLimit: integer(env.AI_DAILY_REQUEST_LIMIT, 20, 1, 1000, 'AI_DAILY_REQUEST_LIMIT'),
    liveMonthlyLimit: integer(env.AI_MONTHLY_REQUEST_LIMIT, 200, 1, 10000, 'AI_MONTHLY_REQUEST_LIMIT')
  };
}
