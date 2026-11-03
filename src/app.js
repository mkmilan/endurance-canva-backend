import express from 'express';
import { createHash, timingSafeEqual, randomUUID } from 'node:crypto';
import { validateLesson } from '../contracts/validation.js';
import { catalog, lessonSchema, generateLesson, GenerationError } from './generation.js';
import { isAllowedAuthRoute, providerConfigured, logStorageUnavailable } from './creator.js';
import { CreatorError } from './quotas.js';

const hash = (value) => createHash('sha256').update(value).digest();
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createApp({ config, creator = null, generator = generateLesson, clock = Date.now } = {}) {
  if (!config) throw new Error('Application configuration is required.');
  const app = express();
  app.disable('x-powered-by');
  let windowStart = clock();
  let windowCount = 0;
  let activeGenerations = 0;
  let setupWindowStart = clock();
  let setupWindowCount = 0;
  const liveReady = () => Boolean(creator?.healthy && providerConfigured(config));
  const currentMode = () => liveReady() ? 'live' : 'demo';
  const errorResponse = (res, status, code, message, requestId) => res.status(status).json({ status: 'error', error: { code, message, requestId } });
  function storageError(res, requestId) {
    creator?.markUnavailable();
    logStorageUnavailable();
    return errorResponse(res, 503, 'OWNER_STORAGE_UNAVAILABLE', 'Creator access is temporarily unavailable. The guided demo is still available.', requestId);
  }
  function creatorError(res, error, requestId) {
    if (error instanceof CreatorError) {
      if (error.retryAfter) res.set('Retry-After', String(error.retryAfter));
      return errorResponse(res, error.status, error.code, error.message, requestId);
    }
    return storageError(res, requestId);
  }
  const trustedOrigin = (req) => Boolean(config.studioOrigin && req.get('origin') === config.studioOrigin);
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
    next();
  });
  app.get('/health', (_req, res) => res.json({ status: 'ok', service: 'endurance-canvas-api', version: '0.2.0', mode: currentMode() }));
  app.use('/api', (req, res, next) => {
    if (config.serviceToken) {
      const header = req.get('authorization') || '';
      const supplied = header.startsWith('Bearer ') ? header.slice(7) : '';
      if (!timingSafeEqual(hash(supplied), hash(config.serviceToken))) return errorResponse(res, 401, 'UNAUTHORIZED', 'Backend access requires an authenticated studio request.', req.requestId);
    }
    next();
  });
  // Better Auth must receive the untouched request stream. The service-token
  // boundary and exact route allowlist apply before its handler.
  app.all('/api/auth/*splat', (req, res) => {
    const path = req.path.slice('/api/auth'.length);
    if (!isAllowedAuthRoute(path, req.method)) return errorResponse(res, 404, 'NOT_FOUND', 'This route is not available.', req.requestId);
    if (!creator) return errorResponse(res, 503, 'AUTH_UNAVAILABLE', 'Creator access has not been connected yet. The guided demo is available.', req.requestId);
    if (req.method === 'POST') {
      if (!trustedOrigin(req)) return errorResponse(res, 403, 'INVALID_ORIGIN', 'Open creator access from the studio website.', req.requestId);
      if (!req.is('application/json')) return errorResponse(res, 415, 'INVALID_CONTENT_TYPE', 'Send an application/json request.', req.requestId);
      const length = req.get('content-length');
      if (!length || !/^\d+$/.test(length)) return errorResponse(res, 411, 'CONTENT_LENGTH_REQUIRED', 'A bounded JSON request is required.', req.requestId);
      if (Number(length) > 16384) return errorResponse(res, 413, 'REQUEST_TOO_LARGE', 'The request is too large.', req.requestId);
      if (config.production && !req.get('x-canvas-client-ip')) return errorResponse(res, 400, 'CLIENT_ADDRESS_REQUIRED', 'Creator access could not verify this request. Please try again.', req.requestId);
    }
    if (!config.production && !req.get('x-canvas-client-ip')) req.headers['x-canvas-client-ip'] = '127.0.0.1';
    return Promise.resolve(creator.authHandler(req, res)).catch(() => {
      if (!res.headersSent) return storageError(res, req.requestId);
      res.end();
    });
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  app.get('/api/v1/catalog', (req, res) => {
    if (req.query.version !== undefined && req.query.version !== '1') return errorResponse(res, 404, 'CATALOG_NOT_FOUND', 'That evidence catalogue version is not available.', req.requestId);
    res.json({ ...catalog, schema: lessonSchema, mode: currentMode() });
  });
  app.get('/api/v1/creator', async (req, res) => {
    if (!creator) return res.json({ status: 'ok', auth: { configured: false, signedIn: false, setupAvailable: false }, ai: { available: false } });
    try { return res.json(await creator.status(req.headers)); }
    catch { return storageError(res, req.requestId); }
  });
  app.post('/api/v1/creator/setup', async (req, res) => {
    if (!creator) return errorResponse(res, 503, 'AUTH_UNAVAILABLE', 'Creator access has not been connected yet.', req.requestId);
    if (!trustedOrigin(req)) return errorResponse(res, 403, 'INVALID_ORIGIN', 'Open owner setup from the studio website.', req.requestId);
    if (clock() - setupWindowStart >= 60000) { setupWindowStart = clock(); setupWindowCount = 0; }
    if (setupWindowCount >= 10) {
      res.set('Retry-After', '60');
      return errorResponse(res, 429, 'RATE_LIMITED', 'Please wait a minute before trying owner setup again.', req.requestId);
    }
    setupWindowCount += 1;
    try { return res.json(await creator.setup(req.body)); }
    catch (error) { return creatorError(res, error, req.requestId); }
  });
  app.post('/api/v1/generations', async (req, res) => {
    const input = req.body;
    const allowed = ['requestId', 'mode', 'generationMode', 'prompt', 'currentContent', 'baseRevision'];
    if (!object(input) || Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000 || !['create', 'refine'].includes(input.mode) || (input.generationMode !== undefined && !['demo', 'live'].includes(input.generationMode))) return errorResponse(res, 400, 'INVALID_REQUEST', 'Send a create/refine request, demo/live generation mode and a prompt between 1 and 4000 characters.', req.requestId);
    if (input.requestId !== undefined && (typeof input.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(input.requestId))) return errorResponse(res, 400, 'INVALID_REQUEST', 'The request identifier is invalid.', req.requestId);
    const requestId = input.requestId || req.requestId;
    const generationMode = input.generationMode || 'demo';
    if (input.baseRevision !== undefined && (!Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0)) return errorResponse(res, 400, 'INVALID_REQUEST', 'The draft revision is invalid.', requestId);
    if (input.mode === 'refine' || input.currentContent !== undefined) {
      const validity = validateLesson(input.currentContent);
      if (!validity.valid) return errorResponse(res, 422, 'INVALID_LESSON', validity.errors.join(' '), requestId);
    }
    let ownerSession;
    if (generationMode === 'live') {
      if (!creator) return errorResponse(res, 503, 'LIVE_UNAVAILABLE', 'Live AI is not connected yet. Use the guided demo for now.', requestId);
      if (!trustedOrigin(req)) return errorResponse(res, 403, 'INVALID_ORIGIN', 'Use live AI from the studio website.', requestId);
      try { ownerSession = await creator.session(req.headers); }
      catch { return storageError(res, requestId); }
      // The client can disconnect while the authoritative session is loading,
      // before the generation close listener below exists. Do not reserve or
      // start paid work for a response that has already closed.
      if (res.destroyed) return;
      if (!ownerSession) return errorResponse(res, 401, 'OWNER_REQUIRED', 'Sign in to your creator account to use live AI.', requestId);
      if (!liveReady()) return errorResponse(res, 503, 'LIVE_UNAVAILABLE', 'Live AI is not connected yet. Use the guided demo for now.', requestId);
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
    let reservation;
    let completionStatus = 'failed';
    let usage;
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);
    try {
      if (res.destroyed) return;
      if (generationMode === 'live') {
        try { reservation = await creator.quota.reserve(ownerSession.user.id, requestId, input); }
        catch (error) { return creatorError(res, error, requestId); }
      }
      if (res.destroyed || controller.signal.aborted) { completionStatus = 'cancelled'; return; }
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { timedOut = true; controller.abort(); reject(new Error('Generation timed out')); }, config.timeoutMs);
      });
      const cancellation = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Generation aborted')), { once: true }));
      const result = await Promise.race([generator(structuredClone({ ...input, requestId }), { ...config, mode: generationMode }, controller.signal), timeout, cancellation]);
      usage = result.usage;
      if (result.status === 'unsupported') {
        completionStatus = 'unsupported';
        return res.json({ status: 'unsupported', message: result.message, supportedLessonTypes: result.supportedLessonTypes, requestId, baseRevision: input.baseRevision ?? null, mode: generationMode });
      }
      if (result.status === 'invalid') { completionStatus = 'invalid'; return errorResponse(res, 422, 'INVALID_LESSON', result.message, requestId); }
      const checked = validateLesson(result.content);
      if (result.status !== 'ok' || !checked.valid) { completionStatus = 'invalid'; return errorResponse(res, 502, 'INVALID_GENERATION', 'The generated lesson did not pass validation. Your previous draft is unchanged.', requestId); }
      completionStatus = 'ok';
      return res.json({ status: 'ok', requestId, baseRevision: input.baseRevision ?? null, mode: generationMode, content: result.content, message: result.message });
    } catch (error) {
      completionStatus = timedOut ? 'timed_out' : controller.signal.aborted ? 'cancelled' : 'failed';
      if (res.destroyed) return;
      if (!timedOut && error instanceof GenerationError) {
        usage = error.usage;
        return errorResponse(res, error.httpStatus, error.code, error.message, requestId);
      }
      return errorResponse(res, timedOut ? 504 : 502, timedOut ? 'GENERATION_TIMEOUT' : 'GENERATION_FAILED', timedOut ? 'The request took too long. Your previous draft is unchanged.' : 'The generation service could not complete this request. Your previous draft is unchanged.', requestId);
    } finally {
      clearTimeout(timer);
      res.off('close', onClose);
      controller.abort();
      activeGenerations -= 1;
      if (reservation) {
        // The reservation is already durable and counts even if completion
        // metadata cannot be saved. Retrying never issues a second model call.
        try { await creator.quota.complete(reservation, completionStatus, usage); }
        catch { creator.markUnavailable(); logStorageUnavailable(); }
      }
    }
  });
  app.use((req, res) => errorResponse(res, 404, 'NOT_FOUND', 'This route is not available.', req.requestId));
  app.use((error, req, res, _next) => {
    const tooLarge = error.type === 'entity.too.large';
    return errorResponse(res, tooLarge ? 413 : 400, tooLarge ? 'REQUEST_TOO_LARGE' : 'INVALID_JSON', tooLarge ? 'The request is too large.' : 'Send a valid JSON request.', req.requestId);
  });
  return app;
}
