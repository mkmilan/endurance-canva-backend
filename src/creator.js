import { createHash, timingSafeEqual } from 'node:crypto';
import { MongoClient } from 'mongodb';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from '@better-auth/mongo-adapter';
import { fromNodeHeaders, toNodeHandler } from 'better-auth/node';
import { createQuotaStore, CreatorError } from './quotas.js';

const AUTH_ROUTES = new Map([
  ['/sign-in/email', 'POST'], ['/sign-out', 'POST'], ['/change-password', 'POST'], ['/get-session', 'GET'],
]);
const safeLog = (event) => console.warn(JSON.stringify({ event, service: 'endurance-canvas-api' }));

export function isAllowedAuthRoute(path, method) {
  return AUTH_ROUTES.get(path) === method;
}

export function providerConfigured(config) {
  return config.mode === 'live' && Boolean(config.gatewayKey && config.modelId);
}

export function validSetupToken(token, config, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || !/^[a-f0-9]{64}$/.test(config.setupTokenHash || '') || config.setupExpiresAt <= now) return false;
  return timingSafeEqual(createHash('sha256').update(token).digest(), Buffer.from(config.setupTokenHash, 'hex'));
}

export function mongoClientOptions(config) {
  return {
    // One Render process allows two concurrent generations. Five connections
    // leave room for sessions/setup without exhausting a shared Atlas budget.
    maxPoolSize: 5,
    minPoolSize: 0,
    // Driver 7.8 removed experimental timeoutMS. These supported options bound
    // individual network/pool phases, not the entire multi-operation request.
    serverSelectionTimeoutMS: config.mongoTimeoutMs,
    connectTimeoutMS: config.mongoTimeoutMs,
    socketTimeoutMS: config.mongoTimeoutMs,
    waitQueueTimeoutMS: config.mongoTimeoutMs,
  };
}

export async function createCreatorServices(config, { clock = Date.now, client: suppliedClient } = {}) {
  if (!config.authConfigured) return null;
  const client = suppliedClient || new MongoClient(config.mongoUri, mongoClientOptions(config));
  const operationOptions = { maxTimeMS: config.mongoTimeoutMs };
  let healthy = true;
  try {
    await client.connect();
    const db = client.db(config.mongoDatabase);
    await db.command({ ping: 1 }, operationOptions);
    // This durable unique constraint closes concurrent setup races. Signup's
    // transaction creates both the user and password credential or neither.
    await db.collection('user').createIndex({ canvasOwner: 1 }, {
      name: 'canvas_single_owner', unique: true, partialFilterExpression: { canvasOwner: 'owner' }, ...operationOptions,
    });
    const quota = createQuotaStore({ db, client, config, clock });
    await quota.initialize();
    const commonOptions = {
      appName: 'Endurance Canvas',
      secret: config.authSecret,
      baseURL: config.studioOrigin,
      basePath: '/api/auth',
      trustedOrigins: [config.studioOrigin],
      database: mongodbAdapter(db, { client }),
      logger: { disabled: true },
      user: { additionalFields: { canvasOwner: { type: 'string', required: true, defaultValue: 'owner', input: false } } },
      session: { expiresIn: 60 * 60 * 24 * 7, updateAge: 60 * 60 * 24, cookieCache: { enabled: false } },
      advanced: {
        cookiePrefix: 'endurance-canvas',
        useSecureCookies: config.production,
        ipAddress: { ipAddressHeaders: ['x-canvas-client-ip'] },
      },
      rateLimit: {
        enabled: true, storage: 'database', window: 60, max: 60,
        customRules: { '/sign-in/email': { window: 60, max: 5 }, '/change-password': { window: 60, max: 3 } },
      },
    };
    const passwordOptions = { enabled: true, minPasswordLength: 12, maxPasswordLength: 128 };
    const auth = betterAuth({ ...commonOptions, emailAndPassword: { ...passwordOptions, disableSignUp: true } });
    // This instance is deliberately private: its handler is never returned or
    // mounted. Only the token-checked setup operation below may invoke signup.
    const bootstrapAuth = betterAuth({ ...commonOptions, emailAndPassword: { ...passwordOptions, autoSignIn: false } });
    const nodeHandler = toNodeHandler(auth);
    const owner = () => db.collection('user').findOne({ canvasOwner: 'owner' }, { projection: { _id: 1 }, ...operationOptions });
    const setupEnabled = () => Boolean(config.setupTokenHash && config.setupExpiresAt > clock());

    async function session(headers) {
      // Disable cookie cache and refresh: every paid action reads the database.
      // The public get-session endpoint handles session cookie renewal.
      const result = await auth.api.getSession({ headers: fromNodeHeaders(headers), query: { disableCookieCache: true, disableRefresh: true } });
      if (result?.user.canvasOwner !== 'owner') return null;
      return result;
    }

    async function status(headers) {
      const [currentOwner, signedIn] = await Promise.all([owner(), session(headers)]);
      const limits = signedIn ? await quota.limits(signedIn.user.id) : undefined;
      healthy = true;
      return {
        status: 'ok',
        auth: {
          configured: true,
          signedIn: Boolean(signedIn),
          setupAvailable: !currentOwner && setupEnabled(),
          ...signedIn ? { user: { name: signedIn.user.name, email: signedIn.user.email } } : {},
        },
        ai: {
          available: providerConfigured(config),
          ...signedIn ? { modelId: config.modelId || '', limits } : {},
        },
      };
    }

    async function setup(input) {
      if (!setupEnabled() || await owner()) throw new CreatorError(409, 'SETUP_UNAVAILABLE', 'Owner setup is closed. Sign in with your creator account.');
      if (!validSetupToken(input?.token, config, clock())) throw new CreatorError(403, 'INVALID_SETUP_TOKEN', 'This owner setup link is not valid.');
      const allowed = ['token', 'name', 'email', 'password'];
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some((key) => !allowed.includes(key)) || typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80 || typeof input.email !== 'string' || input.email.length > 254 || typeof input.password !== 'string' || input.password.length < 12 || input.password.length > 128) throw new CreatorError(400, 'INVALID_SETUP', 'Enter a name, valid email and a password with 12–128 characters.');
      // Direct auth.api calls bypass Better Auth's HTTP limiter. A durable
      // minute bucket bounds expensive hashing even across process restarts.
      const minute = Math.floor(clock() / 60000);
      const setupAttempts = db.collection('ownerSetupAttempts');
      let attempt;
      try {
        attempt = await setupAttempts.findOneAndUpdate(
          { _id: String(minute) }, { $inc: { count: 1 } }, { upsert: true, returnDocument: 'after', ...operationOptions },
        );
      } catch (error) {
        if (error.code !== 11000) throw error;
        attempt = await setupAttempts.findOneAndUpdate(
          { _id: String(minute) }, { $inc: { count: 1 } }, { returnDocument: 'after', ...operationOptions },
        );
      }
      if (!attempt) throw new Error('Owner setup attempt counter unavailable.');
      if (attempt.count > 5) throw new CreatorError(429, 'RATE_LIMITED', 'Please wait a minute before trying owner setup again.', 60);
      try {
        await bootstrapAuth.api.signUpEmail({ body: { name: input.name.trim(), email: input.email.trim(), password: input.password } });
      } catch (error) {
        if (await owner()) throw new CreatorError(409, 'SETUP_UNAVAILABLE', 'Owner setup is already complete. Sign in with your creator account.');
        // Better Auth can translate a concurrent transaction conflict into
        // FAILED_TO_CREATE_USER before the winner is visible to this read.
        // Keep setup retryable; do not misreport valid credentials as invalid.
        if (error.body?.code === 'FAILED_TO_CREATE_USER') throw new CreatorError(409, 'SETUP_RETRY', 'Another setup request may still be finishing. Refresh creator access before trying again.');
        if (error.statusCode >= 400 && error.statusCode < 500) throw new CreatorError(400, 'INVALID_SETUP', 'Owner setup could not be completed. Check your email and password and try again.');
        throw error;
      }
      return { status: 'ok', message: 'Your creator account is ready. Sign in with the email and password you chose.' };
    }

    return {
      authHandler: (req, res) => nodeHandler(req, res),
      session, status, setup, quota,
      get healthy() { return healthy; },
      markUnavailable() { healthy = false; },
      async close() { await client.close(); },
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}

export async function initializeCreator(config) {
  try { return await createCreatorServices(config); }
  catch {
    safeLog('creator_storage_unavailable_demo_only');
    return null;
  }
}

export function logStorageUnavailable() { safeLog('creator_storage_operation_failed'); }
