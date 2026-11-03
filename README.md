# Endurance Canvas — backend

A small API for creating and refining validated interactive endurance lessons.

**Status: documentation baseline, 2026-11-03. Application code has not been scaffolded.** No API, database, model credentials, or backend deployment has been configured.

## Project documents

The shared plan lives in [mkmilan/endurance-canva-dosc](https://github.com/mkmilan/endurance-canva-dosc). The repository is named `dosc`; links intentionally use that spelling.

- [Product and scope](https://github.com/mkmilan/endurance-canva-dosc/blob/main/01-product-and-scope.md)
- [Architecture, content contract, and API](https://github.com/mkmilan/endurance-canva-dosc/blob/main/02-architecture-and-stack.md)
- [Features and build order](https://github.com/mkmilan/endurance-canva-dosc/blob/main/03-features-and-build-plan.md)
- [Current progress](https://github.com/mkmilan/endurance-canva-dosc/blob/main/04-progress.md)
- [Quality and later publishing](https://github.com/mkmilan/endurance-canva-dosc/blob/main/05-quality-and-publishing.md)

Frontend: [mkmilan/endurance-canva-frontend](https://github.com/mkmilan/endurance-canva-frontend).

## Planned stack and responsibilities

Plain JavaScript, Node.js, Express, schema validation, and the Vercel AI SDK behind a small generation adapter. Start with a mock provider and a curated lesson/evidence catalogue. Evaluate and configure a current live model at M2. MongoDB/Mongoose is planned for later durable hosted storage, not required for the initial local studio.

This repository owns the canonical `contracts/` schema and shared fixtures when M1 implements them. The frontend consumes a generated copy pinned to a backend commit. Model output is declarative content selecting reviewed components; it cannot introduce executable code, source URLs, ownership, approval, or publication state.

Initial planned routes are health, catalogue, and generation/refinement. A generation returns a candidate and leaves saving to the local studio. Later durable-save endpoints use server-assigned ownership and revision checks.

## Development and release boundary

The initial API runs on localhost. Keep all provider credentials server-side. A future hosted studio requires protection of both the creator interface and direct backend access, together with explicit generation limits. Deployment and paid services belong to a later milestone.

Add verified installation, environment, run, and test instructions when scaffolding exists. Commit safe environment examples and lockfiles at that stage. Keep central progress honest and link backend commits when tasks are verified.
