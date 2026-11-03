# Endurance Canvas — backend

The separate API for the Endurance Canvas teaching studio. It supplies the versioned lesson/evidence catalogue and creates validated three-zone lesson candidates.

## Current release

Version **0.1.0** implements a protected Express API, canonical browser-compatible contracts, and a **guided demo** generation adapter. Demo responses use prepared teaching content and supported editing rules; they are explicitly labelled and make no model calls.

An optional live adapter uses the Vercel AI SDK and AI Gateway. It is disabled by default and has not been evaluated against a real model in this release. Live mode needs a configured model, server-side credentials, and an owner-protected frontend before it is exposed remotely.

Draft storage remains in the frontend browser. MongoDB persistence and public lesson publishing are later milestones.

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

Tests cover threshold equality, contract validation, malformed imports, protected routes, generation/refinement, unsupported topics, size/rate limits, timeouts, and preservation of prior content. They do not verify live-model quality.

## Routes

| Route | Behaviour |
| --- | --- |
| `GET /health` | Public minimal health, version, and `demo`/`live` mode |
| `GET /api/v1/catalog?version=1` | Trusted versioned evidence metadata and lesson schema |
| `POST /api/v1/generations` | Create/refine a candidate; does not save or publish |

All `/api` requests require `Authorization: Bearer <BACKEND_SERVICE_TOKEN>` when a token is configured. Production refuses to start without a token of at least 32 characters. Keep this value in the backend and frontend server environment only.

Generation input has `requestId`, `mode` (`create` or `refine`), and `prompt`. For refinement, also send `currentContent` and optionally `baseRevision`. Success returns `status`, `requestId`, `baseRevision`, `mode`, `content`, and `message`. Unsupported topics return `status: "unsupported"` with a helpful message. Errors return `status: "error"` and an `error` object containing `code`, `message`, and `requestId`.

Supported demo refinements include “Make it simpler,” “Add more detail,” “Explain LT1,” “Show an example above LT2,” “Set power to 220 W,” “Set LT1 to 170 W,” and “Use a blue accent.” Invalid threshold edits return a validation error.

## Contracts and evidence

`contracts/` is the canonical source for the schema, first example, evidence catalogue, and dependency-free validation helpers. The frontend consumes a generated copy pinned to this repository's commit. Update both applications' fixtures when changing the contract.

The fictional thresholds are supplied inputs, not physiological predictions. The Seiler/Kjerland source supports the specifically qualified ventilatory three-zone framework, not these LT1/LT2 wattages. The creator must still review authored explanatory content.

## Render configuration

- Runtime: Node, using the pinned `.node-version`.
- Build: `npm ci`.
- Start: `npm start`.
- Health check: `/health`.
- Required environment: `NODE_ENV=production`, `AI_MODE=demo`, and a strong `BACKEND_SERVICE_TOKEN`.
- The server binds to `0.0.0.0` in production and uses Render's `PORT`.

Generation has request-size, global per-process minute, concurrency, and timeout limits. The SDK retry count is zero. These in-memory limits reset on restart and are **not** a persistent daily spending cap. Demo mode has no model charges. Persistent quotas and a chosen budget are needed before broader live-AI use.

Never commit real env files or provider/database keys. Configure `AI_GATEWAY_API_KEY` and a currently available `AI_MODEL_ID` only when enabling and evaluating live mode.

## Project links

[Frontend](https://github.com/mkmilan/endurance-canva-frontend) · [Project guide](https://github.com/mkmilan/endurance-canva-dosc) · [Architecture](https://github.com/mkmilan/endurance-canva-dosc/blob/main/02-architecture-and-stack.md) · [Build checklist](https://github.com/mkmilan/endurance-canva-dosc/blob/main/03-features-and-build-plan.md) · [Progress](https://github.com/mkmilan/endurance-canva-dosc/blob/main/04-progress.md)
