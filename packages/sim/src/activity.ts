/**
 * The rule every secondary activity obeys (spec §5.2, §5.3).
 *
 * > Some may be surprisingly deep. **None may compete with making Some More.
 * > None generates currency, XP, or obligation.**
 *
 * `discovery.ts` makes the equivalent guarantee about mystery structurally —
 * `DiscoveryOutcome` has nowhere to put an unlock — and backs it with
 * {@link assertNoGating} for data arriving from untyped sources. Secondary
 * activities need the same guarantee for the same reason, and it has to hold
 * for their *readouts* specifically: a skip count is a fact about a throw, and
 * the moment anything in the product treats it as a score the activity has
 * become a minigame.
 *
 * So the public summary of every activity is checked against a list of the
 * words a score is spelled with. This is not decoration: the fishing model
 * would be a very natural place for somebody to add `personalBest`, and the
 * test suite would go green.
 */

/**
 * Field names that would turn an activity into a game.
 *
 * Matched case-insensitively against whole key names and against camelCase
 * segments, so `bestScore`, `best_score` and `score` are all caught.
 *
 * Deliberately excludes words this codebase already uses in an innocent sense
 * — `record` as in `SandwichRecord`, `target` as in `PlayerState.moveTarget` —
 * because a check that cries wolf is a check that gets deleted.
 */
const FORBIDDEN_FIELDS: readonly string[] = [
  'score',
  'scores',
  'points',
  'xp',
  'exp',
  'experience',
  'level',
  'levels',
  'rank',
  'ranking',
  'grade',
  'stars',
  'medal',
  'trophy',
  'achievement',
  'achievements',
  'unlock',
  'unlocks',
  'unlocked',
  'locked',
  'reward',
  'rewards',
  'currency',
  'coins',
  'credits',
  'streak',
  'combo',
  'multiplier',
  'highscore',
  'best',
  'personalbest',
  'quota',
  'goal',
  'goals',
  'objective',
  'objectives',
  'completion',
  'completed',
  'percent',
  'percentage',
  'progresspercent',
  'required',
  'requires',
  'gates',
  'gate',
];

/** Splits `bestScore` / `best_score` / `best-score` into lowercase segments. */
function segmentsOf(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_-]+/)
    .map((part) => part.toLowerCase())
    .filter((part) => part.length > 0);
}

/**
 * Throws if a value an activity hands to the rest of the product looks like a
 * score, an unlock or an obligation.
 *
 * Walks plain objects and arrays only; it deliberately does not follow class
 * instances or functions, because nothing in a readout should be one.
 *
 * @param label  What is being checked, for the error message.
 * @param value  The readout — a summary object, an event, a record.
 */
export function assertNoScoring(label: string, value: unknown, path = ''): void {
  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      assertNoScoring(label, value[i], `${path}[${i}]`);
    }
    return;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== null && prototype !== Object.prototype) return;

  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    const segments = segmentsOf(key);
    const offending =
      FORBIDDEN_FIELDS.includes(lower) || segments.some((part) => FORBIDDEN_FIELDS.includes(part));
    if (offending) {
      throw new Error(
        `${label} exposes "${path ? `${path}.` : ''}${key}". ` +
          'No secondary activity generates currency, XP or obligation, and none is scored (spec §5.2, §5.3).',
      );
    }
    assertNoScoring(label, entry, path ? `${path}.${key}` : key);
  }
}

/**
 * The one thing an activity is allowed to produce: something that happened.
 *
 * There is no `value`, no `tier` and no `grants`. A skipping stone that sinks
 * produces one of these too, and it reads exactly as well as one that skipped
 * eleven times — which is the whole point (spec §4.2's "a burned marshmallow
 * is a story", applied outward to the rest of the campsite).
 */
export interface ActivityMoment {
  /** Which activity. */
  readonly activity: 'stone-skipping' | 'fishing' | 'stargazing' | 'flashlight' | 'sitting';
  /** Seconds into the session. */
  readonly at: number;
  /** A warm, factual line. Never a verdict. */
  readonly telling: string;
}
