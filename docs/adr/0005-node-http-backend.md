# ADR-0005 — `node:http` with a typed router instead of a framework

**Status:** accepted

## Context
The backend needs identity, passport, campsites, sessions, world state, rewards, commerce, moderation and analytics. The brief calls for clear domain boundaries without unnecessary microservices.

## Decision
One service on `node:http` with a small typed router, zod-validated at every edge, repository interfaces at every storage boundary. No web framework.

## Consequences
- The dependency surface of a service that will handle payments stays minimal, and the request path is fully readable.
- Domain modules are plain TypeScript with explicit interfaces, so extraction into separate services later is mechanical if it is ever justified.
- Cost: middleware conveniences (multipart parsing, cookie handling, OpenAPI generation) must be written or added deliberately. Revisit if that cost grows.
