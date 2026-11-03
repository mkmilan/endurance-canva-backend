# Endurance Canvas — backend

The separate API for the Endurance Canvas teaching studio. It supplies the versioned lesson/evidence catalogue and creates validated three-zone lesson candidates.

## Current release

Version **0.2.0** adds optional creator access with Better Auth, MongoDB-backed sessions, a one-time owner setup, and persistent live-AI request allowances. The **guided demo** remains available without an account or a database. Demo responses use prepared teaching content and supported editing rules; they are explicitly labelled and make no model calls.

The live adapter uses the Vercel AI SDK and AI Gateway. Every live request requires an authoritative owner session, configured model credentials, and a successful database quota reservation. `AI_MODE=live` enables readiness checks; missing credentials keep live generation unavailable. Deployment-specific activation and real-model evaluation are recorded in the project progress document, not inferred from passing fixture tests.

Draft storage remains in the frontend browser. MongoDB currently stores only authentication, request allowance counters, and generation attempt metadata. Cloud lesson saving and public lesson publishing are later milestones.

## Run locally

Use Node **24.22.1** (recorded in `.node-version`).

```bash
npm ci
cp .env.example .env
npm run dev
```

The default local address is `http://127.0.0.1:4000`. `npm start` runs the server without file watching. The frontend calls this API through its server-side proxy.

```bash
npm test
npm run check
```

Tests cover the contracts and demo, authentication boundaries, token expiry, UTC allowance boundaries, classified AI errors, and actual AI SDK structured-output handling with injected test models. To include the authentication/database integration tests, set `TEST_MONGODB_URI` to a disposable MongoDB replica set before running `npm test`. The tests use uniquely named databases and clean up only those databases. Without this variable, the integration tests explicitly skip. No test invokes a paid model.

`test/browser-server.js` is a separate browser-test fixture. It requires `TEST_MONGODB_URI` and a random `CANVAS_TEST_SETUP_TOKEN` of at least 32 characters, refuses `NODE_ENV=production`, uses an isolated database, and injects a clearly labelled deterministic live response. Its daily/monthly allowances are 3/10. It must never be used as the Render start command.

## Routes

| Route | Behaviour |
| --- | --- |
| `GET /health` | Public minimal health, version, and `demo`/`live` mode |
| `GET /api/v1/catalog?version=1` | Trusted versioned evidence metadata and lesson schema |
| `POST /api/v1/generations` | Create/refine a candidate; does not save or publish |
| `GET /api/v1/creator` | Creator connection, session, setup availability, and owner-only request allowances |
| `POST /api/v1/creator/setup` | One-time owner creation using the unexpired setup token |
| `POST /api/auth/sign-in/email` | Creator sign-in through Better Auth |
| `POST /api/auth/sign-out` | Revoke the current session |
| `POST /api/auth/change-password` | Change password with the current password |
| `GET /api/auth/get-session` | Read/renew the session |

All `/api` requests require `Authorization: Bearer <BACKEND_SERVICE_TOKEN>` when a token is configured. Production refuses to start without a token of at least 32 characters. Keep this value in the backend and frontend server environment only.

Generation input has optional `requestId`, `mode` (`create` or `refine`), and `prompt`. Optional `generationMode` is `demo` or `live` and defaults to `demo`, even on a backend configured for live AI. For refinement, also send `currentContent` and optionally `baseRevision`. Success returns `status`, `requestId`, `baseRevision`, `mode`, `content`, and `message`. Unsupported topics return `status: "unsupported"` with a helpful message. Errors return `status: "error"` and an `error` object containing `code`, `message`, and `requestId`.

Every live request needs a valid owner session cookie. Client-supplied ownership flags are rejected. The frontend proxy forwards cookies and the verified studio origin while adding the server-only service token. Ordinary Better Auth HTTP endpoints keep their native response format.

## Creator setup and sessions

Configure `MONGODB_URI`, `MONGODB_DATABASE`, a random `AUTH_SECRET` of at least 32 characters, and the exact `STUDIO_ORIGIN`. Use the canonical HTTPS frontend origin in production. MongoDB must support transactions, as Atlas replica sets do. Only the Render backend connects to Atlas; the frontend uses its same-origin server proxy.

Set `OWNER_SETUP_TOKEN_HASH` to the SHA256 hash of a cryptographically random setup token and `OWNER_SETUP_EXPIRES_AT` to an explicit ISO8601 expiry. Deliver the raw token privately in a URL fragment or have the owner enter it in the setup form; never put it in a query string, repository, or logs. The owner chooses their name, email, and password (12–128 characters). Setup creates no session; the owner then signs in normally. Email is an unverified sign-in identifier in this release; there is no email-delivery or password-reset flow.

Normal signup routes are disabled. A private, never-mounted Better Auth instance performs initial signup only after token validation. A unique `canvasOwner` index and transactional user/credential creation guarantee a single owner. Failed validation or rolled-back creation leaves setup retryable; an existing owner closes setup permanently. Account presence, rather than a separate consumed lock, prevents a crash between creation and response from stranding setup.

Session cookies are HttpOnly, Secure in production, SameSite=Lax, and restricted to the frontend host. Every paid action reads the authoritative session from MongoDB; cookie caching is disabled. Authentication routes use a strict HTTP allowlist and database-backed rate limits. The frontend must overwrite `x-canvas-client-ip` from Vercel's trusted address header; production auth mutations reject a missing trusted address. Password changes can revoke other sessions. Recovery without a current password requires an explicit operator-assisted recovery procedure; no unauthenticated reset endpoint is exposed.

Supported demo refinements include “Make it simpler,” “Add more detail,” “Explain LT1,” “Show an example above LT2,” “Set power to 220 W,” “Set LT1 to 170 W,” and “Use a blue accent.” Invalid threshold edits return a validation error.

## Contracts and evidence

`contracts/` is the canonical source for the schema, first example, evidence catalogue, and dependency-free validation helpers. The frontend consumes a generated copy pinned to this repository's commit. Update both applications' fixtures when changing the contract.

The fictional thresholds are supplied inputs, not physiological predictions. The Seiler/Kjerland source supports the specifically qualified ventilatory three-zone framework, not these LT1/LT2 wattages. The creator must still review authored explanatory content.

## Render configuration

- Runtime: Node, using the pinned `.node-version`.
- Build: `npm ci`.
- Start: `npm start`.
- Health check: `/health`.
- Required environment: `NODE_ENV=production` and a strong `BACKEND_SERVICE_TOKEN`. `AI_MODE=demo` is the default.
- The server binds to `0.0.0.0` in production and uses Render's `PORT`.

Database initialization failure leaves the process serving the public guided demo with creator/live access disabled. After fixing a startup database configuration or network problem, restart/redeploy the backend to initialize creator access. Runtime database failures close paid paths; the creator status request can restore healthy readiness after connectivity recovers. Database diagnostics are not returned to clients or printed with credentials.

Generation has request-size, global per-process minute, concurrency, and timeout limits. The SDK retry count is zero. Persistent live allowances default to **20 requests/day and 200 requests/month**, using UTC boundaries. Override them with `AI_DAILY_REQUEST_LIMIT` and `AI_MONTHLY_REQUEST_LIMIT`. The two counters and the unique owner/request identifier are reserved in one MongoDB transaction before calling the generator. Failed, invalid, unsupported, timed-out, and cancelled reserved attempts count toward the allowance; automatic refunds could otherwise allow duplicate or unbounded calls.

Reuse of a live request ID returns 409 without another provider call, including after a process restart. Request IDs are retained indefinitely for idempotency. Stored attempt data consists of owner ID, request ID, an input hash, timestamps, status, and bounded token-count/model/generation identifiers when available. Raw prompts, generated lesson content, passwords, and provider diagnostics are not stored in the attempt collection. These are request allowances, **not a monetary spending cap**. Demo mode has no model charges and consumes no persistent AI allowance.

Never commit real env files or provider/database keys. Configure `AI_GATEWAY_API_KEY` and a currently available `AI_MODEL_ID` when enabling and evaluating live mode. The Mongo pool is capped at 5 connections for this single small Render process; database operations and transaction retries default to an 8 second deadline, independent of the model generation timeout.

## Project links

[Frontend](https://github.com/mkmilan/endurance-canva-frontend) · [Project guide](https://github.com/mkmilan/endurance-canva-dosc) · [Architecture](https://github.com/mkmilan/endurance-canva-dosc/blob/main/02-architecture-and-stack.md) · [Build checklist](https://github.com/mkmilan/endurance-canva-dosc/blob/main/03-features-and-build-plan.md) · [Progress](https://github.com/mkmilan/endurance-canva-dosc/blob/main/04-progress.md)
