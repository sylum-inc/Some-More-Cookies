/**
 * @somemore/protocol — the shared, versioned contract between every Some More
 * client and the API service.
 *
 * Everything here is a zod schema plus its inferred type, and a handful of pure
 * functions (decay, scoring, state-machine legality) that must give the same
 * answer on the client and on the server.
 *
 * Nothing in this package imports node built-ins or talks to the network.
 */
export * from './version.js';
export * from './common.js';
export * from './media.js';
export * from './identity.js';
export * from './passport.js';
export * from './campsite.js';
export * from './session.js';
export * from './sandwich.js';
export * from './rewards.js';
export * from './commerce.js';
export * from './events.js';
export * from './moderation.js';
