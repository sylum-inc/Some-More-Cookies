/**
 * The launch catalogue.
 *
 * Order here is authoring order, not priority — discovery weighting is data
 * on each manifest (`discovery`), never array position, so a live-ops reorder
 * cannot silently change what players see.
 */

import type { EnvironmentManifest } from '../schema.js';

import { ASHFALL_BARRENS } from './ashfall-barrens.js';
import { CEDAR_SWITCHBACK } from './cedar-switchback.js';
import { CICADA_BOTTOMS } from './cicada-bottoms.js';
import { COPPERLINE_HALT } from './copperline-halt.js';
import { FOXGLOVE_FELLS } from './foxglove-fells.js';
import { LANTERN_MESA } from './lantern-mesa.js';
import { LONGLIGHT_SHORE } from './longlight-shore.js';
import { LOONWATER_NARROWS } from './loonwater-narrows.js';
import { MELTWATER_CIRQUE } from './meltwater-cirque.js';
import { MIRROR_FLATS } from './mirror-flats.js';
import { PINE_HOLLOW } from './pine-hollow.js';
import { SWEETGRASS_COULEE } from './sweetgrass-coulee.js';

export {
  ASHFALL_BARRENS,
  CEDAR_SWITCHBACK,
  CICADA_BOTTOMS,
  COPPERLINE_HALT,
  FOXGLOVE_FELLS,
  LANTERN_MESA,
  LONGLIGHT_SHORE,
  LOONWATER_NARROWS,
  MELTWATER_CIRQUE,
  MIRROR_FLATS,
  PINE_HOLLOW,
  SWEETGRASS_COULEE,
};

/** Every environment shipping at launch (spec §5.4: the strongest 10–12). */
export const ENVIRONMENTS: readonly EnvironmentManifest[] = [
  PINE_HOLLOW,
  LONGLIGHT_SHORE,
  LANTERN_MESA,
  MELTWATER_CIRQUE,
  SWEETGRASS_COULEE,
  CICADA_BOTTOMS,
  ASHFALL_BARRENS,
  MIRROR_FLATS,
  FOXGLOVE_FELLS,
  CEDAR_SWITCHBACK,
  COPPERLINE_HALT,
  LOONWATER_NARROWS,
];

/**
 * The environment a brand-new campsite gets when nothing else is specified.
 * Matches the protocol default (`CreateCampsiteRequestSchema.environmentId`).
 */
export const DEFAULT_ENVIRONMENT_ID = 'pine_hollow';
