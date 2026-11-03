import { createHash } from 'node:crypto';

export class CreatorError extends Error {
  constructor(status, code, message, retryAfter) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export function quotaPeriods(now = Date.now()) {
  const date = new Date(now);
  const day = date.toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  return {
    daily: { key: day, resetsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)) },
    monthly: { key: month, resetsAt: new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)) },
  };
}

export function generationInputHash(input) {
  // Hash only generation inputs. Prompts and draft content are never persisted.
  return createHash('sha256').update(JSON.stringify({
    mode: input.mode,
    prompt: input.prompt,
    currentContent: input.currentContent ?? null,
    baseRevision: input.baseRevision ?? null,
  })).digest('hex');
}

export function createQuotaStore({ db, client, config, clock = Date.now }) {
  const counters = db.collection('generationQuota');
  const attempts = db.collection('generationAttempts');
  const limitFor = (period) => period === 'daily' ? config.liveDailyLimit : config.liveMonthlyLimit;
  const duplicate = (existing, inputHash) => new CreatorError(409,
    existing.inputHash === inputHash ? 'DUPLICATE_REQUEST' : 'REQUEST_ID_CONFLICT',
    'This request identifier has already been used. No second AI request was made.');

  async function initialize() {
    await attempts.createIndex({ ownerId: 1, requestId: 1 }, { name: 'owner_request_unique', unique: true });
    await counters.createIndex({ ownerId: 1, period: 1 });
  }

  async function limits(ownerId) {
    const periods = quotaPeriods(clock());
    const entries = await Promise.all(Object.entries(periods).map(async ([period, value]) => {
      const counter = await counters.findOne({ _id: `${ownerId}:${period}:${value.key}` });
      return [period, { used: counter?.used || 0, limit: limitFor(period), resetsAt: value.resetsAt.toISOString() }];
    }));
    return Object.fromEntries(entries);
  }

  async function reserve(ownerId, requestId, input) {
    const now = clock();
    const periods = quotaPeriods(now);
    const inputHash = generationInputHash(input);
    // Create zero-count period records before the transaction. Concurrent
    // first-use upserts can raise E11000 instead of a retryable write conflict;
    // the transaction itself only updates existing counters.
    for (const [period, value] of Object.entries(periods)) {
      try {
        await counters.updateOne({ _id: `${ownerId}:${period}:${value.key}` }, { $setOnInsert: {
          ownerId, period, periodKey: value.key, resetsAt: value.resetsAt, used: 0,
        } }, { upsert: true });
      } catch (error) {
        if (error.code !== 11000) throw error;
      }
    }
    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        const existing = await attempts.findOne({ ownerId, requestId }, { session });
        if (existing) throw duplicate(existing, inputHash);
        for (const [period, value] of Object.entries(periods)) {
          const _id = `${ownerId}:${period}:${value.key}`;
          const counter = await counters.findOne({ _id }, { session });
          if ((counter?.used || 0) >= limitFor(period)) throw new CreatorError(429, 'QUOTA_EXCEEDED',
            `Your ${period === 'daily' ? 'daily' : 'monthly'} AI request allowance is used. The guided demo is still available.`,
            Math.max(1, Math.ceil((value.resetsAt.getTime() - now) / 1000)));
          const updated = await counters.updateOne({ _id }, { $inc: { used: 1 } }, { session });
          if (updated.matchedCount !== 1) throw new Error('Generation quota counter unavailable.');
        }
        await attempts.insertOne({ ownerId, requestId, inputHash, status: 'reserved', createdAt: new Date(now) }, { session });
      });
    } catch (error) {
      // A racing transaction may encounter the unique request index first.
      if (error.code === 11000) {
        const existing = await attempts.findOne({ ownerId, requestId });
        if (existing) throw duplicate(existing, inputHash);
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return { ownerId, requestId };
  }

  async function complete(reservation, status, usage) {
    const safeUsage = {};
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens']) {
      if (Number.isSafeInteger(usage?.[field]) && usage[field] >= 0) safeUsage[field] = usage[field];
    }
    for (const field of ['modelId', 'generationId']) {
      if (typeof usage?.[field] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(usage[field])) safeUsage[field] = usage[field];
    }
    await attempts.updateOne(reservation, { $set: { status, completedAt: new Date(clock()), ...(Object.keys(safeUsage).length ? { usage: safeUsage } : {}) } });
  }

  return { initialize, limits, reserve, complete };
}
