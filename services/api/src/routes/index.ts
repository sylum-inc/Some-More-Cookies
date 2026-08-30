import type { AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';
import { analyticsRoutes } from './analytics.js';
import { authRoutes } from './auth.js';
import { campsiteRoutes } from './campsites.js';
import { codeRoutes } from './codes.js';
import { contentRoutes } from './content.js';
import { liveOpsRoutes } from './liveops.js';
import { commerceRoutes } from './commerce.js';
import { healthRoutes } from './health.js';
import { mediaRoutes } from './media.js';
import { moderationRoutes } from './moderation.js';
import { passportRoutes } from './passport.js';
import { rewardRoutes } from './rewards.js';
import { sandwichRoutes } from './sandwiches.js';
import { sessionRoutes } from './sessions.js';

/** The complete route table, grouped by domain module. */
export function buildRoutes(services: ServiceRegistry): AnyRoute[] {
  return [
    ...healthRoutes(services),
    ...authRoutes(services),
    ...passportRoutes(services),
    ...mediaRoutes(services),
    ...campsiteRoutes(services),
    ...sessionRoutes(services),
    ...sandwichRoutes(services),
    ...rewardRoutes(services),
    ...commerceRoutes(services),
    ...moderationRoutes(services),
    ...analyticsRoutes(services),
    ...contentRoutes(services),
    ...liveOpsRoutes(services),
    ...codeRoutes(services),
  ];
}

/** Human-readable route table; printed on boot and used by the README. */
export function describeRoutes(routes: readonly AnyRoute[]): string[] {
  return routes.map(
    (route) =>
      `${route.method.padEnd(6)} ${route.path.padEnd(52)} auth=${route.auth}${route.idempotent === true ? ' idempotent' : ''}`,
  );
}
