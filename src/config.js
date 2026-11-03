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
  if (mode === 'live' && (!env.AI_MODEL_ID || !env.AI_GATEWAY_API_KEY)) throw new Error('Live mode requires AI_MODEL_ID and AI_GATEWAY_API_KEY.');
  return {
    production, mode, serviceToken,
    port: integer(env.PORT, 4000, 1, 65535, 'PORT'),
    host: env.HOST || (production ? '0.0.0.0' : '127.0.0.1'),
    timeoutMs: integer(env.GENERATION_TIMEOUT_MS, 25000, 100, 55000, 'GENERATION_TIMEOUT_MS'),
    maxPerMinute: integer(env.GENERATION_MAX_PER_MINUTE, 12, 1, 120, 'GENERATION_MAX_PER_MINUTE'),
    maxConcurrent: integer(env.GENERATION_MAX_CONCURRENT, 2, 1, 5, 'GENERATION_MAX_CONCURRENT'),
    maxOutputTokens: integer(env.AI_MAX_OUTPUT_TOKENS, 2500, 500, 6000, 'AI_MAX_OUTPUT_TOKENS'),
    modelId: env.AI_MODEL_ID || '',
    gatewayKey: env.AI_GATEWAY_API_KEY || ''
  };
}
