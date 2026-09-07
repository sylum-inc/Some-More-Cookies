/**
 * Which campsite you are at, and how you get to another one.
 *
 * The device was pinned. `resolveCampsite` minted one seed under
 * `some-more/campsite/v1`, handed it to `selectEnvironment` with neither
 * `discoveredIds` nor `region`, and — because that draw is a pure function of
 * the seed — every boot for the life of that localStorage entry landed in the
 * same one of twelve. Eleven authored environments were unreachable on any
 * given device, which §5.4 forbids in as many words: "every player must
 * eventually be able to discover every core environment", and region "may only
 * weight discovery, never lock it".
 *
 * The fix is not to make every night somewhere new. That would trade one
 * broken promise for another: §3.3 says a returning player comes back to
 * *their* campsite with their own serialized SM-01, and §6.3 says returning is
 * always warm. A world where you never return is a world where nothing
 * remembers you.
 *
 * So there are two things here rather than one.
 *
 * **A root seed** — who you are, minted once and never changed. Every campsite
 * you ever visit is derived from it, so the fox at Cedar Switchback is your
 * fox on every device you sign in from.
 *
 * **A current environment** — where you are, stored, and changed only when you
 * walk out. Booting returns you to it. Walking up the trail and going takes
 * the next one you have not seen, because `selectEnvironment` prefers the
 * undiscovered pool and falls back to the whole catalogue once you have been
 * everywhere. That is the constructive no-lock guarantee `discoveryOrder`
 * already proves, used at last.
 */

import { getEnvironment, selectEnvironment, type EnvironmentManifest } from '@somemore/content';

/** The device's own seed. Was the campsite seed; is now the root of all of them. */
const ROOT_KEY = 'some-more/campsite/v1';
/** Where this device is camped right now. */
const WHERE_KEY = 'some-more/campsite/where/v1';

export interface Campsite {
  readonly environmentId: string;
  /**
   * The campsite's identity, and the key its memory is filed under.
   *
   * Derived from the root and the environment together, so that returning to
   * a place you have camped at before is genuinely the same place — same
   * SM-01 serial, same landmark arrangement, same wildlife individuals — and
   * so that two campsites never share a memory record. `passport.campsites` is
   * keyed by this, and it also carries an `environmentId`; one seed used in
   * two environments would overwrite one with the other.
   */
  readonly campsiteSeed: string;
}

function read(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    // Private windows, cleared site data, storage disabled. A campsite you
    // cannot store is still a campsite you can sit at.
    return '';
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* As above: the night works, it is only tomorrow that will not remember. */
  }
}

/** A device's root seed, minted on first boot and stable thereafter. */
export function rootSeed(mint: () => string): string {
  const stored = read(ROOT_KEY);
  if (stored.length > 0) return stored;
  const minted = mint();
  write(ROOT_KEY, minted);
  return minted;
}

/** The campsite seed for one environment, from the root. */
export function campsiteSeedFor(root: string, environmentId: string): string {
  return `${root}:${environmentId}`;
}

/**
 * Where this device is camped.
 *
 * `?camp=` and `?env=` still override everything, which is how the tests and
 * a shared link pin an exact campsite; neither is stored, so a link does not
 * move a player's own camp out from under them.
 */
export function currentCampsite(search: string, root: string): Campsite {
  const params = new URLSearchParams(search);

  const pinnedSeed = params.get('camp');
  const requested = params.get('env');
  const pinnedEnvironment = requested ? getEnvironment(requested) : undefined;
  if (pinnedSeed !== null || pinnedEnvironment !== undefined) {
    const environmentId = pinnedEnvironment?.id ?? selectEnvironment({ seed: pinnedSeed ?? root }).id;
    return { environmentId, campsiteSeed: pinnedSeed ?? campsiteSeedFor(root, environmentId) };
  }

  const stored = read(WHERE_KEY);
  const environment = (stored.length > 0 ? getEnvironment(stored) : undefined) ?? selectEnvironment({ seed: root });
  return { environmentId: environment.id, campsiteSeed: campsiteSeedFor(root, environment.id) };
}

/**
 * The next campsite along the trail.
 *
 * `found` is every environment this device has actually camped in, read from
 * the passport rather than kept as its own counter — the record of where you
 * have been is already the record of where you have been. It is passed as
 * `discoveredIds`, so the draw comes from the places you have not seen until
 * there are none left, and then from all of them.
 *
 * The seed carries the count of places found so that the draw moves on: with
 * a fixed seed and an exhausted pool, `selectEnvironment` is a pure function
 * and would return the same campsite every time you walked out of it.
 */
export function nextCampsite(root: string, found: readonly string[], from: string): Campsite {
  const environment = pickAway(root, found, from);
  return { environmentId: environment.id, campsiteSeed: campsiteSeedFor(root, environment.id) };
}

function pickAway(root: string, found: readonly string[], from: string): EnvironmentManifest {
  for (let attempt = 0; attempt < 8; attempt++) {
    const picked = selectEnvironment({ seed: `${root}:${found.length}:${attempt}`, discoveredIds: found });
    // Walking out of a place and back into it is the one answer the trail may
    // not give. Only reachable once everywhere has been seen, when the pool is
    // the whole catalogue again.
    if (picked.id !== from) return picked;
  }
  return selectEnvironment({ seed: `${root}:${found.length}`, discoveredIds: [...found, from] });
}

/** Records that this device is now camped somewhere, for the next boot. */
export function settleAt(campsite: Campsite): void {
  write(WHERE_KEY, campsite.environmentId);
}
