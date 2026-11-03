import express from 'express';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { validateLesson } from '../contracts/validation.js';
import { catalog, lessonSchema, generateLesson } from './generation.js';

const hash = (value) => createHash('sha256').update(value).digest();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createApp({ config, generator = generateLesson, clock = Date.now } = {}) {
  if (!config) throw new Error('Application configuration is required.');
  const app = express();
  app.disable('x-powered-by');
  let windowStart = clock();
  let windowCount = 0;
  let activeGenerations = 0;
  const errorResponse = (res, status, code, message, requestId) => res.status(status).json({ status: 'error', error: { code, message, requestId } });
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'endurance-canvas-api', version: '0.1.0', mode: config.mode }));
  app.use('/api', (req, res, next) => {
    if (config.serviceToken) {
      const header = req.get('authorization') || '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!timingSafeEqual(hash(supplied), hash(config.serviceToken))) return errorResponse(res, 401, 'UNAUTHORIZED', 'Backend access requires an authenticated studio request.', req.requestId);
    }
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  app.get('/api/v1/catalog', (req, res) => {
    if (req.query.version !== undefined && req.query.version !== '1') return errorResponse(res, 404, 'CATALOG_NOT_FOUND', 'That evidence catalogue version is not available.', req.requestId);
    res.json({ ...catalog, schema: lessonSchema, mode: config.mode });
  });
  app.post('/api/v1/generations', async (req, res) => {
    const input = req.body;
    const allowed = ['requestId', 'mode', 'prompt', 'currentContent', 'baseRevision'];
    if (!object(input) || Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 || !['create', 'refine'].includes(input.mode)) return errorResponse(res, 400, 'INVALID_REQUEST', 'Send a create/refine request and a prompt between 1 and 4000 characters.', req.requestId);
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId))) return errorResponse(res, 400, 'INVALID_REQUEST', 'The request identifier is invalid.', req.requestId);
    const requestId = input.requestId || req.requestId;
    if (input.baseRevision !== undefined && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)) return errorResponse(res, 400, 'INVALID_REQUEST', 'The draft revision is invalid.', requestId);
    if (input.mode === 'refine' || input.currentContent !== undefined) {
      const validity = validateLesson(input.currentContent);
      if (!validity.valid) return errorResponse(res, 422, 'INVALID_LESSON', validity.errors.join(' '), requestId);
    }
    const now = clock();
    if (now - windowStart >= 60000) { windowStart = now; windowCount = 0; }
    if (windowCount >= config.maxPerMinute || activeGenerations >= config.maxConcurrent) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((60000 - (now - windowStart)) / 1000))));
      return errorResponse(res, 429, 'RATE_LIMITED', 'The studio is handling several requests. Please try again shortly.', requestId);
    }
    windowCount += 1;
    activeGenerations += 1;
    const controller = new AbortController();
    let timedOut = false;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Generation timed out')); }, config.timeoutMs);
    });
    try {
      const result = await Promise.race([generator(structuredClone(input), config, controller.signal), timeout]);
      if (result.status === 'unsupported') return res.json({ ...result, requestId, baseRevision: input.baseRevision ?? null, mode: config.mode });
      if (result.status === 'invalid') return errorResponse(res, 422, 'INVALID_LESSON', result.message, requestId);
      const checked = validateLesson(result.content);
      if (result.status !== 'ok' || !checked.valid) return errorResponse(res, 502, 'INVALID_GENERATION', 'The generated lesson did not pass validation. Your previous draft is unchanged.', requestId);
      res.json({ status: 'ok', requestId, baseRevision: input.baseRevision ?? null, mode: config.mode, content: result.content, message: result.message });
    } catch {
      return errorResponse(res, timedOut ? 504 : 502, timedOut ? 'GENERATION_TIMEOUT' : 'GENERATION_FAILED', timedOut ? 'The request took too long. Your previous draft is unchanged.' : 'The generation service could not complete this request. Your previous draft is unchanged.', requestId);
    } finally {
      clearTimeout(timer);
      controller.abort();
      activeGenerations -= 1;
    }
  });
  app.use((req, res) => errorResponse(res, 404, 'NOT_FOUND', 'This route is not available.', req.requestId));
  app.use((error, req, res, _next) => {
    const tooLarge = error.type === 'entity.too.large';
    return errorResponse(res, tooLarge ? 413 : 400, tooLarge ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON', tooLarge ? 'The request is too large.' : 'Send a valid JSON request.', req.requestId);
  });
  return app;
}
