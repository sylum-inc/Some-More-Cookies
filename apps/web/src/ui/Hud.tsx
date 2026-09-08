/**
 * The heads-up layer.
 *
 * Deliberately sparse. There are no quest markers, no XP, no objectives list
 * (spec §5.3). What is here: a quiet line of guidance when a player would
 * otherwise be stuck, a non-numeric heat reading during roasting, subtitles,
 * and the two corner affordances (Passport, settings).
 */

import type { RitualStage, RitualState } from '@somemore/sim';
import { Sprite, type SpriteName } from './Sprite.js';
import { REACH_SPRITES, fireSprite, roastSprite, timeSprite, weatherSprite } from './iconography.js';
import {
  describeArmful,
  describeSeat,
  heatBand,
  isBanked,
  isEmberBed,
  patchAt,
  sampleHeat,
  woodType,
  MAX_ARMFUL,
} from '@somemore/sim';
import { SURFACE, TOKENS, FONT_STACK, machineText, plate } from './styles.js';

export interface HudProps {
  ritual: RitualState;
  /** What is within arm's reach right now, if anything. */
  reach: { id: string } | null;
  /** How the stone is being held, while there is one. */
  grip?: ThrowGrip;
  /** Whether the player is sitting down, so the log can offer the opposite. */
  seated?: boolean;
  /** Who has the roasting stick at a shared fire, when it is not you. */
  /** What the player is crouched over, so the prompt can offer to end it. */
  inspecting?: string | null;
  stickHolder?: string | null;
  /** The acts that have no object to touch: posture, glasses, the beam, the survey. */
  onLieBack?: () => void;
  onBinoculars?: () => void;
  onTorchFocus?: () => void;
  onSurvey?: () => void;
  onUse: () => void;
  exploring: boolean;
  stage: RitualStage;
  subtitle: string | null;
  /** Pointer or keyboard, so the guidance line names the right controls. */
  controls: 'pointer' | 'keyboard';
  /** A report that must reach the player whether or not subtitles are on. */
  notice: string | null;
  /** How far the roasting stick has been pulled back toward the plate, 0..1. */
  withdraw: number;
  /** What is around the player, when they have asked. Null when they have not. */
  survey: readonly string[] | null;
  textScale: number;
  highContrast: boolean;
  /** Pixels of bezel to stay inside of. See the note on the root element. */
  frameInset?: number;
  subtitlesEnabled: boolean;
  /**
   * Whatever belongs in the middle of the bottom row — today, the bite ring.
   *
   * Passed in rather than rendered here because it is App's control and App
   * owns when it exists; taken in rather than left fixed to the viewport
   * because two siblings anchored to the same edge at two different offsets
   * is how the HUD kept landing on itself.
   */
  bottomCentre?: React.ReactNode;
  /**
   * The thumb pad, when there is a thumb. Handed in for the same reason as
   * `bottomCentre`: App owns whether this device has one, and the HUD owns
   * where everything at the bottom of the screen is relative to everything
   * else at the bottom of the screen.
   */
  stick?: React.ReactNode;
  onOpenPassport: () => void;
  onOpenSettings: () => void;
  onFinishRoasting: () => void;
  onTakeSandwich: () => void;
  onLeaveSandwich: () => void;
  onPhoto: () => void;
  onOpenTerminal: () => void;
}

/**
 * What the fire is doing, in words, for the accessible name on its glyph.
 *
 * The picture is for eyes; a screen reader gets the sentence. Deliberately the
 * same four states the sprite has and no more precision than that — a number
 * here would be the §5.3 rule broken through the accessibility layer, which is
 * exactly the sort of back door that gets missed.
 */
export function describeFireState(fire: { flame: number; emberMass: number }): string {
  if (fire.flame > 0.35) return 'burning well';
  if (fire.flame > 0.08) return 'low';
  if (fire.emberMass > 0.02) return 'down to embers';
  return 'out';
}

/** A quiet, diegetic line. Never an objective, never a checklist. */
/** What a reachable thing offers, in plain words. */
const REACH_LABELS: Record<string, string> = {
  fire: 'Poke the coals',
  woodpile: 'Take a log',
  marshmallows: 'Take a marshmallow',
  machine: 'The SM-01',
  plate: 'The plate',
  'log-seat': 'Sit down',
  radio: 'The radio',
  torch: 'Take the torch',
  stones: 'Pick up a stone',
  'water-edge': 'The water',
  rod: 'Take the rod',
};

/**
 * What a reachable thing offers *right now*.
 *
 * Contextual, because the world offers rather than menus: the log says "stand
 * up" once you are on it, the torch says "switch it off" once it is in your
 * hand, and the water says "throw it" once there is a stone in the other one.
 */
export function reachLabel(id: string, ritual?: RitualState, seated = false, inspecting: string | null = null): string {
  if (ritual) {
    /*
     * A pit with nothing in it is not a pit you poke.
     *
     * "Poke the coals" over a cold hearth is the interface promising something
     * the world cannot do — there are no coals, poking does nothing, and a
     * player who has just been told the fire went out is handed the verb for a
     * fire that did not. What a cold pit offers is the other end of the same
     * mechanic: lay something dry in it and put a light to it.
     */
    if (id === 'fire' && ritual.fire.flame <= 0.02 && ritual.fire.emberMass <= 0.03) {
      const tinder = ritual.fire.logs.some((log) => log.grade === 'tinder' && log.mass > 0);
      return tinder ? 'Put a light to it' : 'Lay a new fire';
    }
    /*
     * Somewhere there is wood.
     *
     * Named by the campsite, not by the table above: which places exist and
     * what is at them come out of the environment's own fuel profile, so the
     * prompt has to be built from the patch rather than looked up.
     */
    const patch = patchAt(ritual.gathering, id);
    if (patch) {
      if (patch.remaining <= 0) return 'Picked over';
      if (ritual.gathering.armful.length >= MAX_ARMFUL) return 'Arms full';
      return patch.grade === 'tinder'
        ? 'Gather tinder'
        : patch.grade === 'kindling'
          ? 'Gather kindling'
          : `Take ${woodType(patch.woodId).label.toLowerCase()}`;
    }
    // A named thing at this campsite offers its own name, because that is
    // what a landmark is: the thing you would point at and call something.
    const landmark = ritual.landmarks.find((l) => l.id === id);
    if (landmark) return landmark.introduced ? landmark.label : `Look at ${landmark.label.toLowerCase()}`;
    /*
     * The way out says where it goes, not that it is an exit: "Follow the
     * trail out" is a thing you do, where "Travel" or "Leave campsite" would
     * be a menu item wearing a sentence.
     */
    /*
     * One of the campsite's small things. The label is the secret's own
     * title, which the catalogue already wrote for a player to read, and the
     * verb says it is a posture you are holding rather than a button.
     */
    if (id.startsWith('look:')) {
      const curio = ritual.curios.find((c) => `look:${c.secretId}` === id);
      if (curio) return inspecting === curio.secretId ? 'Straighten up' : `Look closely at ${curio.label.toLowerCase()}`;
    }
    if (id === 'trailhead') return 'Follow the trail out';
    // Hands full of wood means putting wood on, not poking the coals.
    if (id === 'fire' && ritual.gathering.armful.length > 0) return 'Lay it on';
    // And a pit under ash wants the ash off before it wants anything else.
    if (id === 'fire' && isBanked(ritual.fire)) return 'Rake the ash back';
    if (id === 'log-seat') return seated ? 'Stand up' : 'Sit down';
    if (id === 'torch') return ritual.torch.held ? (ritual.torch.on ? 'Switch it off' : 'Switch it on') : 'Take the torch';
    if (id === 'water-edge') return ritual.skipping.held ? 'Throw it' : 'Pick up a stone';
    if (id === 'stones') return ritual.skipping.held ? 'Try another' : 'Pick up a stone';
    if (id === 'rod') {
      switch (ritual.fishing.phase) {
        case 'stowed':
          return 'Take the rod';
        case 'nibble':
          return 'Strike';
        case 'landed':
          return 'Put it back';
        case 'ready':
        case 'soaking':
          return 'Cast';
        default:
          return 'The rod';
      }
    }
  }
  return REACH_LABELS[id] ?? 'Use';
}

/**
 * How the stone is sitting in your hand, in words.
 *
 * Never a number and never a rating: these are descriptions of a grip, and a
 * grip that produces one skip is described exactly as plainly as one that
 * produces nine (spec §5.2, §5.3).
 */
export function describeGrip(power: number, tilt: number, spin: number): string {
  const wind = power < 0.3 ? 'loose' : power < 0.65 ? 'wound back' : 'wound right back';
  const face = tilt < 0.18 ? 'edge-on' : tilt < 0.45 ? 'face just open' : tilt < 0.72 ? 'face well open' : 'face flat to the sky';
  const wrist = spin < 0.2 ? 'no wrist in it' : spin < 0.6 ? 'some wrist' : 'a hard flick';
  return `${wind}, ${face}, ${wrist}`;
}

/**
 * The one line of guidance, in the language of whatever the player is using.
 *
 * Only the stages whose wording is genuinely about *how* change. The rest —
 * "Take it out", "Bite from whichever side you like" — say what to do rather
 * than how to do it and read the same either way, and every action they refer
 * to is a real focusable button rather than something in the canvas.
 *
 * Telling a keyboard player to "drag sideways" is not a small infelicity: the
 * non-gestural path is the whole of spec §12, and a path nobody is told about
 * is a path nobody takes.
 */
/**
 * The SM-01's line, which follows the machine rather than the stage.
 *
 * It used to be one sentence — "Load it, shut the door, and set the machine
 * running" — held for the whole twelve-step sequence, so the machine was still
 * asking to be loaded while it was three quarters of the way through freezing
 * something. That was found by printing what every stage actually said, which
 * no pixel comparison could see.
 *
 * The running stages say there is nothing to do, because there is not. A
 * machine that keeps issuing instructions while it works reads as a machine
 * that is waiting for you, and this one is the opposite: it is the part of the
 * ritual where you stand back and listen to it.
 */
function machineLine(machine: RitualState['machine'], keys: boolean): string {
  switch (machine.stage) {
    case 'idle':
      return keys ? 'L puts it in.' : 'Put it in.';
    case 'loaded':
    case 'door-closing':
      return keys ? 'D shuts the door.' : 'Shut the door.';
    case 'door-closed':
      return keys ? 'X throws the latch.' : 'Throw the latch.';
    case 'latched':
      if (!machine.confirmed) {
        return keys ? '1, 2 or 3 picks a program. Enter confirms it.' : 'Pick a program, then confirm it.';
      }
      return keys ? 'P pulls the lever.' : 'Pull the lever.';
    case 'armed':
      return keys ? 'P pulls the lever.' : 'Pull the lever.';
    case 'processing':
    case 'transforming':
    case 'freezing':
      /*
       * The run is 36, 50 or 66 seconds depending on the programme, and this
       * used to read "Nothing to do now but listen to it." That was true when
       * the machine was an anchored stage: the camera was parked in front of
       * the unit and there genuinely was nothing else to do. It is no longer
       * true, and it was the worst thing the line could say — a minute of
       * standing still, on instruction, in a campsite you are now free to walk
       * around.
       *
       * Naming the length matters as much as the permission. An unknown wait
       * is a much longer wait than a known one, and "about a minute" is a fact
       * rather than a countdown, which would be the objective this product
       * spends its whole voice avoiding.
       */
      return 'About a minute. Nothing here needs you until it opens.';
    case 'complete':
      return keys ? 'X releases the latch.' : 'Release the latch.';
    case 'unlatched':
    case 'opening':
      return keys ? 'D opens the door.' : 'Open the door.';
    case 'revealed':
      return 'Take it out.';
    case 'fault':
      return 'Something has jammed. Release the latch and look inside.';
    default:
      return keys ? 'L puts it in.' : 'Put it in.';
  }
}

/**
 * A bed with heat in it, nothing burning, and nothing fine enough to catch.
 *
 * The state a player is in about ninety seconds into a return visit: they have
 * raked the ash off, they can see the coals, they have put a split log on it,
 * and nothing at all is happening. What is missing is tinder, and there is
 * none at camp — the woodpile is split logs. Saying so is the difference
 * between a walk out to the treeline and giving up on the campsite.
 */
function needsFineFuel(ritual: RitualState): boolean {
  if (ritual.fire.flame > 0.12) return false;
  if (ritual.fire.emberTemp < 150 || ritual.fire.emberMass < 0.03) return false;
  // A full roasting bed is not a fire in trouble, it is the fire you wanted.
  // Strictly below `isEmberBed`'s threshold so the two can never both speak.
  if (ritual.fire.emberMass >= 0.16) return false;
  const hasFine = ritual.fire.logs.some((log) => log.grade !== 'log' && log.mass > 0.005);
  const hasFineInHand = ritual.gathering.armful.some((piece) => piece.grade !== 'log');
  return !hasFine && !hasFineInHand;
}

function guidanceFor(
  ritual: RitualState,
  stage: RitualStage,
  controls: 'pointer' | 'keyboard' = 'pointer',
  withdraw = 0,
  stickHolder: string | null = null,
): string {
  const keys = controls === 'keyboard';
  switch (stage) {
    case 'arriving':
      // Not an instruction: the title card carries the one that can be
      // followed. "Walk toward the fire." sat above "TAP TO WALK IN" and
      // nothing moved when anybody tried to walk.
      return 'The fire is ahead.';
    case 'at-fire':
      /*
       * A pit you left banked reads as a dead one, and it is not.
       *
       * This is the single line that stands between "there is heat under
       * there, go and find it" and a player concluding the fire is out and the
       * campsite is broken. It says what is true and what to do about it, and
       * then gets out of the way — the next line, once the ash is off, is the
       * one that explains why the split log they are about to try will not
       * take.
       */
      if (isBanked(ritual.fire)) {
        return keys
          ? 'Grey ash, and heat still under it. E rakes it back off the coals.'
          : 'Grey ash, and heat still under it. Sweep it back off the coals.';
      }
      if (needsFineFuel(ritual)) {
        return 'Those coals are alive but low. They want something finer than a log to catch on.';
      }
      if (isEmberBed(ritual.fire)) return 'The fire has burned down to coals.';
      /*
       * What is in hand changes what the controls do, and the line has to say
       * so. With a stone in hand a drag is the throw and the arrows wind it;
       * "drag to look" was still at the top of the screen through the whole
       * of it.
       */
      if (ritual.skipping.held) {
        return keys
          ? 'Up and down wind it, left and right tilt it, [ and ] spin it. T throws.'
          : 'Pull back to wind it up, sideways for spin. Let go to throw.';
      }
      if (ritual.fishing.phase === 'nibble') return keys ? 'The float is under. R strikes.' : 'The float is under. Strike, now.';
      if (ritual.fishing.phase === 'soaking' || ritual.fishing.phase === 'playing') {
        return keys ? 'Watch the float. R strikes when it goes under.' : 'Watch the float.';
      }
      if (ritual.stargazing.posture === 'reclined') {
        return keys ? 'Look up. V raises the binoculars; C sits you up.' : 'Look up, and hold something in view.';
      }
      if (ritual.torch.held) {
        return keys ? 'Look around to sweep the beam. G twists the head, F puts it out.' : 'Look around to sweep the beam.';
      }
      return keys
        ? 'Look around. WASD walks, the arrow keys look.'
        : 'Look around. Tap to walk, drag to look.';
    case 'roasting':
      // Somebody else has the stick: there is nothing to drag and nothing
      // to take off, and the line saying otherwise was the defect.
      if (stickHolder) return `${stickHolder} has the stick.`;
      if (ritual.marshmallow.burning) {
        return keys
          ? 'It has caught. Press B to blow it out, or let it burn.'
          : 'It has caught. Shake it out, or let it burn.';
      }
      if (withdraw > 0.12) {
        // Said while it happens. A pull that completes silently is
        // indistinguishable from a slip.
        return keys ? 'Keep pulling it back.' : 'Keep pulling back to take it off.';
      }
      return keys
        ? 'Arrows move it in and out, and turn it. Down takes it off.'
        : 'Drag it in and out, sideways to turn. Pull right back to take it off.';
    case 'assembling': {
      const next = ritual.assembly.heldKind;
      if (next) {
        return keys
          ? 'Arrows shift it, [ and ] turn it. Enter sets it down.'
          : 'Set it down where you want it.';
      }
      return keys ? 'Enter picks up the next piece.' : 'Pick up the next piece.';
    }
    case 'machine':
      return machineLine(ritual.machine, keys);
    case 'reveal':
      return keys ? 'Take it out.' : 'Take hold of it and lift it out.';
    case 'eating':
      return 'Bite from whichever side you like.';
    case 'after':
      return 'Sit a while, or make another.';
    default:
      return '';
  }
}

/**
 * A quiet line for whatever the player has picked up.
 *
 * Only ever shown while something is actually in hand, and it says what the
 * thing does rather than what to achieve with it. There is no objective here
 * and there is nothing to complete.
 */
function activityLine(ritual: RitualState, grip: ThrowGrip | undefined): string | null {
  if (ritual.skipping.phase === 'flying') return null;
  if (ritual.skipping.held && grip) return describeGrip(grip.power, grip.tilt, grip.spin);
  if (ritual.fishing.phase === 'nibble') return 'The float goes under.';
  if (ritual.fishing.phase === 'playing') return 'Something is on.';
  if (ritual.fishing.phase === 'soaking') return 'The line is out.';
  if (ritual.stargazing.binoculars) return 'Hold something in view and it will resolve.';
  if (ritual.stargazing.posture === 'reclined') return 'The sky, for tonight.';
  /*
   * What is in your arms.
   *
   * A player who walked to the far side of the clearing for kindling has to be
   * able to tell, when they get back, what they came back with — and there is
   * nowhere in a first-person view to look down at your own hands. Counted by
   * grade rather than listed, which is how an armful of wood presents itself.
   */
  if (ritual.gathering.armful.length > 0) return describeArmful(ritual.gathering);
  // Sitting is the quietest thing here and it still gets a line, because §12
  // says nothing may be delivered through one channel — and what sitting does
  // is otherwise entirely invisible.
  const seated = describeSeat(ritual.seat);
  if (seated) return seated.replace(/^\[|\]$/g, '');
  return null;
}

/** The three numbers the throwing gesture writes. Read-only here. */
export interface ThrowGrip {
  power: number;
  tilt: number;
  spin: number;
}

export function Hud(props: HudProps): React.ReactElement {
  const { ritual, stage, textScale, highContrast } = props;
  const scale = (n: number) => `${n * textScale}px`;

  // Non-numeric heat reading — heat must be legible without relying on colour
  // alone (spec §12).
  let heatLabel = '';
  let heatBandName = 'cold';
  if (stage === 'roasting') {
    const sample = sampleHeat(ritual.fire, ritual.marshmallow.position);
    const total = sample.radiant + sample.convective;
    const band = heatBand(total);
    heatBandName = band;
    heatLabel = {
      cold: 'cold',
      warm: 'warm',
      toasting: 'toasting',
      browning: 'browning',
      scorching: 'scorching',
      burning: 'burning',
    }[band];
  }

  /*
   * What is offered, filtered by the stage.
   *
   * The world reports whatever is within reach, and during assembly and the
   * machine run that was a live button for the wrong thing: "Take a
   * marshmallow" while setting a cracker down, "Poke the coals" while walking
   * to the SM-01 under "Put it in.", and "The SM-01" for the whole of a run
   * that takes nothing from you. Nothing is offered while assembling; at the
   * machine, only the machine, and only while its tray is still waiting.
   */
  const reach = (() => {
    const offered = props.reach;
    if (offered === null) return null;
    if (stage === 'assembling') return null;
    if (stage === 'machine') return offered.id === 'machine' && ritual.machine.stage === 'idle' ? offered : null;
    return offered;
  })();

  /*
   * Kneeling at the pit, the bottom of the frame *is* the fire.
   *
   * The notice and the reach prompt both lived in the lower middle, which is
   * fine from standing height and lands across the flame base and the log
   * ends from a crouch — over the wood being arranged, in the one view built
   * for arranging it. When the pit itself is what is in reach, both move up
   * into the top band, under the guidance line, where the sky is.
   */

  /*
   * Acts with nothing to touch.
   *
   * Lying back, the binoculars, the beam's width and asking what is around
   * you were on four keys and on nothing else, so a phone player could never
   * do any of them. Offered here, in the same band as the reach prompt, only
   * while they apply: "Lie back" once you are sitting, the binoculars once
   * you are lying back, the beam only while the torch is in hand.
   */
  const acts: {
    label: string;
    icon: SpriteName;
    onClick: (() => void) | undefined;
    testId: string;
  }[] = [];
  if (props.exploring) {
    const reclined = ritual.stargazing.posture === 'reclined';
    if (props.seated && !reclined) acts.push({ label: 'Lie back', icon: 'verb-sit', onClick: props.onLieBack, testId: 'act-lie-back' });
    if (reclined) {
      acts.push({
        label: ritual.stargazing.binoculars ? 'Lower the binoculars' : 'Raise the binoculars',
        icon: 'obj-binoculars',
        onClick: props.onBinoculars,
        testId: 'act-binoculars',
      });
      acts.push({ label: 'Sit up', icon: 'verb-stand', onClick: props.onLieBack, testId: 'act-sit-up' });
    }
    if (ritual.torch.held && ritual.torch.on) {
      acts.push({
        label: ritual.torch.focus > 0.5 ? 'Widen the beam' : 'Narrow the beam',
        icon: 'obj-torch',
        onClick: props.onTorchFocus,
        testId: 'act-torch-focus',
      });
    }
    acts.push({
      label: props.survey === null ? 'What is around me?' : 'Enough',
      icon: 'verb-look',
      onClick: props.onSurvey,
      testId: 'act-survey',
    });
  }
  const actsRow =
    acts.length > 0 ? (
      <div
        style={{
          display: 'flex',
          justifyContent: 'flex-end',
          gap: scale(8),
          flexWrap: 'wrap',
          pointerEvents: 'auto',
        }}
      >
        {acts.map((act) => (
          <CornerButton
            key={act.testId}
            testId={act.testId}
            label={act.label}
            icon={act.icon}
            onClick={act.onClick ?? (() => {})}
            textScale={textScale}
            highContrast={highContrast}
          />
        ))}
      </div>
    ) : null;

  /*
   * What is in reach, as the thing itself.
   *
   * The largest text on screen used to be this — a whole phrase, "Look closely
   * at the tin in the creek", in a box under the thumb. It is a picture of the
   * thing now, on the biggest plate in the frame, with the phrase carried on
   * `aria-label` so the screen reader and the keyboard hint are unchanged.
   *
   * A picture of the *noun* rather than of the verb: an icon of a log is
   * unambiguous, where an icon of "take" needs a caption to say what is being
   * taken. The one exception is the fire, whose verb is the interesting part.
   *
   * The amber ring is the only place that colour appears in the HUD. It is
   * what the world wants you to look at, and an accent that shows up anywhere
   * else points at nothing.
   */
  const reachButton =
    props.exploring && reach !== null ? (
      <button
        className="sm-focus"
        data-testid="reach"
        onClick={props.onUse}
        aria-label={reachLabel(reach.id, ritual, props.seated ?? false, props.inspecting ?? null)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: scale(9),
          background: 'linear-gradient(180deg, rgba(46,32,14,0.88), rgba(16,11,6,0.9))',
          color: 'rgba(248,238,218,0.98)',
          border: `1px solid ${TOKENS.amber}`,
          boxShadow:
            'inset 1px 1px 0 rgba(255,210,74,0.22), inset -1px -1px 0 rgba(0,0,0,0.6), 0 2px 12px rgba(0,0,0,0.55)',
          padding: `${9 * textScale}px ${12 * textScale}px`,
          fontSize: scale(12.5),
          letterSpacing: '0.08em',
          borderRadius: 3,
          textAlign: 'right',
          maxWidth: '100%',
          pointerEvents: 'auto',
        }}
      >
        <Sprite name={REACH_SPRITES[reach.id] ?? 'verb-take'} scale={2} />
        {highContrast ? (
          <span>{reachLabel(reach.id, ritual, props.seated ?? false, props.inspecting ?? null)}</span>
        ) : null}
      </button>
    ) : null;

  /*
   * What the world is doing, at a glance, in three pictures.
   *
   * The fire, the hour and the sky — the three things a person sitting at a
   * campsite actually keeps half an eye on, and the three the simulation has
   * always known and never shown. This is the "rich context" a handheld HUD is
   * for, and it is deliberately *pictures* rather than readouts: §5.3 forbids
   * anything a player can read as a score, and a bar that empties is a score
   * however it is drawn. Four states of fire, drawn as a fire looks, read the
   * way the actual pit reads.
   *
   * Hidden during the close work — kneeling at the assembly table, nobody
   * needs to be told what the weather is doing.
   */
  const statusCluster =
    props.exploring && stage !== 'arriving' ? (
      <div
        data-testid="status-cluster"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: scale(2),
          padding: `${scale(3)} ${scale(5)}`,
          background: highContrast ? '#000' : 'linear-gradient(180deg, rgba(30,36,44,0.72), rgba(10,13,18,0.78))',
          border: highContrast ? '2px solid #fff' : '1px solid rgba(166,179,194,0.28)',
          boxShadow: highContrast
            ? 'none'
            : 'inset 1px 1px 0 rgba(200,215,235,0.16), inset -1px -1px 0 rgba(0,0,0,0.5)',
          borderRadius: 3,
          pointerEvents: 'none',
        }}
      >
        <Sprite name={fireSprite(ritual.fire)} scale={1} title={`The fire: ${describeFireState(ritual.fire)}`} />
        <Sprite name={timeSprite(ritual.window)} scale={1} title={`Time: ${ritual.window.replace('-', ' ')}`} />
        <Sprite name={weatherSprite(ritual.weather.kind)} scale={1} title={`Sky: ${ritual.weather.kind.replace('-', ' ')}`} />
      </div>
    ) : null;

  const noticeBox =
    props.notice !== null ? (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="notice"
        style={plate(textScale, highContrast)}
      >
        {props.notice}
      </div>
    ) : null;

  return (
    <div
      style={{
        position: 'fixed',
        /*
         * Inside the bezel, not under it.
         *
         * Everything below anchors to `env(safe-area-inset-*)`, which is the
         * phone's own notch and knows nothing about a steel rail this code
         * drew over the viewport. With the frame on and no allowance made, the
         * guidance line ran under the left rail and lost its first character —
         * found in a screenshot, because no amount of reading the layout would
         * have shown it.
         */
        inset: props.frameInset ?? 0,
        pointerEvents: 'none',
        zIndex: 20,
        fontFamily: FONT_STACK.sans,
      }}
    >
      {/*
        Everything lives on an edge, and the middle of the screen is the world.

        This used to be five text channels stacked down the centre — the reach
        prompt at 18% from the bottom, the notice at 26%, what is in your hands
        at 13%, subtitles at 5%, and the guidance line across the top — over the
        one thing the player is here to look at. Two separate defects in this
        file are two of those channels landing on each other, each fixed by
        moving one of them a few per cent; the third was the notice sitting on
        the fire it was describing. The percentages were never the bug. A
        heads-up display that puts its words where the game is will keep
        producing that defect for as long as it has a middle to put them in.

        So: one column down the left for what the world is saying, one column up
        the right for what your thumb can do, the two corners for everything
        else, and nothing at all between them. Laid out by the browser in both
        cases, because the file has now learned twice that a column cannot get
        this wrong and hand-computed offsets can.
      */}

      {/* Top: the two corner affordances, and the survey under them. */}
      <div
        style={{
          position: 'absolute',
          top: 'env(safe-area-inset-top, 0px)',
          left: 'env(safe-area-inset-left, 0px)',
          right: 'env(safe-area-inset-right, 0px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          pointerEvents: 'none',
        }}
      >
        <div
          data-testid="corner-controls"
          style={{
            display: 'flex',
            gap: 8,
            padding: 12,
            // The status cluster sits opposite the two corner affordances, so
            // the top band reads left-to-right as "what the world is doing"
            // then "what you can open".
            justifyContent: 'space-between',
            alignItems: 'flex-start',
            pointerEvents: 'auto',
          }}
        >
          {statusCluster ?? <span />}
          <div style={{ display: 'flex', gap: 8 }}>
          <CornerButton label="Passport" icon="obj-camera" onClick={props.onOpenPassport} textScale={textScale} highContrast={highContrast} />
          <CornerButton label="Settings" icon="verb-look" onClick={props.onOpenSettings} textScale={textScale} highContrast={highContrast} />
          </div>
        </div>

        {/*
          What is around you, when you ask (audit A5).

          Shown *and* announced. A survey that only a screen reader received
          would be the §12 single-channel rule broken by the feature written to
          keep it — and a sighted player on a keyboard, or anybody who has just
          walked somewhere in the dark, wants the same answer.

          `assertive`, unusually: this is the one line in the product the player
          explicitly asked for, so interrupting whatever else was being read is
          the correct behaviour rather than a rudeness.

          Under the corner controls rather than beside them: at the largest text
          scale on the narrowest phone, a panel wide enough to be worth reading
          and a pair of buttons wide enough to be worth pressing do not both fit
          across one row.
        */}
        {props.survey !== null && props.survey.length > 0 && (
          <div style={{ display: 'flex', padding: `${scale(4)} ${scale(12)} 0` }}>
            <div
              role="status"
              aria-live="assertive"
              aria-atomic="true"
              data-testid="survey"
              style={{
                ...plate(textScale, highContrast),
                maxWidth: 'min(46ch, 78vw)',
                lineHeight: 1.65,
                pointerEvents: 'none',
              }}
            >
              {props.survey.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/*
        The bottom of the screen is one row, laid out by the browser.

        The three things that live down here — what the world is saying, the
        bite targets, and what your thumb can do — used to be three fixed
        elements at three hand-picked offsets, and on a 375 px phone the
        right-hand cluster grew by one wrapped line and landed on the bite
        ring. That is the third time this file has produced that defect from
        the same cause. A row cannot: the lane shrinks, the two ends take what
        they need, and none of them can reach the others.
      */}
      <div
        style={{
          position: 'absolute',
          left: 'env(safe-area-inset-left, 0px)',
          right: 'env(safe-area-inset-right, 0px)',
          bottom: 'env(safe-area-inset-bottom, 0px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'stretch',
          pointerEvents: 'none',
        }}
      >
      {/*
        Down the left: what the world is saying.

        Quietest at the bottom, loudest at the top, so a notice arriving pushes
        nothing the player was already reading. Capped well short of half the
        width so it cannot reach the thumb column on the far side — the two
        never share a row by construction rather than by measurement.
      */}
      <div
        style={{
          padding: scale(12),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: scale(6),
          // Shrinks to whatever the two ends leave it, and never past zero:
          // without `minWidth`, a flex item refuses to go below its longest
          // word and pushes the thumb column off the screen instead.
          maxWidth: 'min(38ch, 100%)',
          pointerEvents: 'none',
        }}
      >
        {noticeBox}
        {props.subtitlesEnabled && props.subtitle && (
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="subtitle"
            style={{ ...plate(textScale, true), fontSize: scale(13) }}
          >
            {props.subtitle}
          </div>
        )}
        {props.exploring && activityLine(ritual, props.grip) && (
          <div
            style={{
              ...plate(textScale, highContrast),
              alignSelf: 'stretch',
              /*
               * The throw's charge, as the plate's own stamped rule warming
               * rather than as a bar filling.
               *
               * It used to be a four-pixel track with an amber fill running
               * across it, which is a meter, and §5.3 does not care how small
               * a meter is. What a bar was doing here was answering "how hard
               * am I about to throw this" — and `describeGrip` already answers
               * that in words, on the line directly above, which is also the
               * non-colour channel §12 requires. So the colour is free to be
               * only a colour: the rule runs from stamped red at rest to amber
               * at full wind-up, and quantifies nothing.
               */
              borderLeftColor:
                ritual.skipping.held && props.grip
                  ? mixStamp(props.grip.power)
                  : undefined,
              borderLeftWidth: ritual.skipping.held && props.grip ? 5 : undefined,
            }}
          >
            <div style={{ ...machineText(textScale), color: SURFACE.ink }}>
              {activityLine(ritual, props.grip)}
            </div>
            {ritual.fishing.phase === 'nibble' && (
              <div style={{ fontSize: scale(11), marginTop: 5, color: TOKENS.ember, fontWeight: 600 }}>now</div>
            )}
          </div>
        )}
        {/*
          The roasting corner: the heat readout, and under it the keyboard
          path's "Take it to the plate".

          The readout is the one non-colour channel for heat (spec §12), which
          is precisely the thing it must never lose. Hidden while somebody else
          has the stick: there is no heat to read on a marshmallow you are not
          holding. `role="status"` so a screen-reader player roasting on the
          arrow keys hears the band change; it only changes on a band change,
          so it does not chatter.
        */}
        {stage === 'roasting' && !props.stickHolder && (
          <>
            <div
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="heat"
              style={{
                ...plate(textScale, highContrast),
                display: 'flex',
                alignItems: 'center',
                gap: scale(10),
              }}
            >
              {/*
                The marshmallow, and the word for what it is doing.

                This was a fill bar with "BURNING" over it — a meter, which
                §5.3 forbids outright, and the one piece of state in the game a
                HUD would most naturally turn into one. The picture is how the
                player reads doneness at the actual fire: they look at the
                marshmallow. So they look at the marshmallow here too, and the
                word underneath is the non-colour channel §12 requires, which
                the bar never was — an amber fill is colour twice over.
              */}
              <Sprite name={roastSprite(heatBandName, ritual.marshmallow.burning)} scale={2} />
              <div>
                <div style={machineText(textScale)}>{heatLabel}</div>
                {ritual.marshmallow.burning && (
                  <div style={{ fontSize: scale(11), marginTop: 3, color: TOKENS.ember, fontWeight: 600 }}>
                    on fire
                  </div>
                )}
              </div>
            </div>
            {/* Kept mounted rather than conditionally rendered on `controls`,
                because a virtual cursor that never fires a keydown would
                otherwise be looking at a document where the button does not
                exist. */}
            <div style={props.controls === 'keyboard' ? { pointerEvents: 'auto' } : SR_ONLY}>
              <CornerButton
                label={ritual.marshmallow.fallen ? 'Take another' : 'Take it to the plate'}
                onClick={props.onFinishRoasting}
                textScale={textScale}
                highContrast={highContrast}
              />
            </div>
          </>
        )}
        {/*
          The standing hint, lowest and quietest of the four.

          A scrim rather than a drop shadow: at thirteen pixels a shadow only
          works over a dark background, and this line has to sit on whatever
          the world puts behind it.
        */}
        <span
          role="status"
          aria-live="polite"
          data-testid="guidance"
          style={{
            letterSpacing: '0.04em',
            ...plate(textScale, highContrast),
            // Quieter than the notice: this is the game telling you which keys
            // exist, not the campsite telling you something happened, and the
            // two must not read as the same voice.
            borderLeftColor: 'rgba(214,203,177,0.30)',
            fontSize: scale(12),
            overflowWrap: 'break-word',
          }}
        >
          {guidanceFor(ritual, stage, props.controls, props.withdraw, props.stickHolder ?? null)}
        </span>
      </div>

      {/*
        And beneath the words, the controls: pad on the left, bite targets in
        the middle, thumb cluster on the right.

        Its own row rather than the same one. Sharing a row with the lane meant
        a 393 px phone gave the words whatever the buttons left over — about
        150 px — and "The reflector on the site post answers from anywhere in
        the site" came out one word per line. Text gets a row, controls get a
        row, and neither has to be told how wide the other is.
      */}
      {/*
        The bite targets, on a row of their own.

        Eight 44 px targets are 352 px and they have to fit a 375 px phone, so
        there is no width left over for a thumb pad on one side and a stack of
        buttons on the other: sharing a row with them put "Bite from side 8"
        squarely over "Photo". It is a targeting control rather than a corner
        control, and it gets the width it needs.
      */}
      {props.bottomCentre !== undefined && (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            padding: `0 ${scale(12)} ${scale(8)}`,
            pointerEvents: 'auto',
          }}
        >
          {props.bottomCentre}
        </div>
      )}

      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: scale(8),
          pointerEvents: 'none',
        }}
      >
        {/* Always present, even with no pad in it: `space-between` needs a
            first child or the thumb cluster walks to the left. */}
        <div style={{ flexShrink: 0, padding: scale(12), paddingTop: 0 }}>{props.stick}</div>

      {/*
        Up the right: what your thumb can do.

        The one contextual verb sits lowest, where a thumb already is, and
        everything optional stacks above it. Right-aligned so the row a button
        is on cannot change how far it is from the corner.
      */}
      <div
        style={{
          padding: scale(12),
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-end',
          gap: scale(8),
          /*
           * Shrinks, and its rows wrap inside it. Refusing to shrink read fine
           * on a laptop and ran "What is around me?", "Photo" and "Take a
           * marshmallow" straight off the right-hand edge of a 393 px phone:
           * `space-between` will happily push a rigid child past the end of
           * the row it is in.
           */
          minWidth: 0,
          pointerEvents: 'none',
        }}
      >
        {actsRow}
        {(stage === 'reveal' || stage === 'eating' || stage === 'after' || stage === 'at-fire') && (
          <div
            data-testid="photo-control"
            style={{
              display: 'flex',
              gap: 8,
              flexWrap: 'wrap',
              justifyContent: 'flex-end',
              pointerEvents: 'auto',
            }}
          >
            {(stage === 'eating' || stage === 'after') && ritual.sandwich && (
              <CornerButton label="Make this real" icon="obj-sandwich" onClick={props.onOpenTerminal} textScale={textScale} highContrast={highContrast} accent />
            )}
            <CornerButton label="Photo" icon="verb-photo" onClick={props.onPhoto} textScale={textScale} highContrast={highContrast} />
          </div>
        )}
        {stage === 'reveal' && ritual.sandwich && (
          <div style={props.controls === 'keyboard' ? { pointerEvents: 'auto' } : SR_ONLY}>
            <CornerButton label="Take it" icon="verb-take" onClick={props.onTakeSandwich} textScale={textScale} highContrast={highContrast} accent />
          </div>
        )}
        {/* The other thing it can be for. Offered only with the s'more in hand
            and untouched — half of one left on the ground is litter, not an
            offering — and it is a quiet button rather than an accented one
            because eating it is still what most people came for. */}
        {stage === 'eating' && ritual.sandwich && ritual.bite.bites === 0 && ritual.offering === null && (
          <div data-testid="leave-control" style={{ pointerEvents: 'auto' }}>
            <CornerButton label="Leave it out" icon="verb-leave-out" onClick={props.onLeaveSandwich} textScale={textScale} highContrast={highContrast} />
          </div>
        )}
        {/* What is within reach. The world offers rather than presenting a
            menu (spec: contextual direct manipulation), so this appears only
            when the player has actually walked up to something. */}
        {reachButton}
      </div>
      </div>
      </div>

      {/* Binoculars. A real optical frame rather than a zoom slider: the field
          narrows and everything outside it is simply not in the eyepieces. */}
      {ritual.stargazing.binoculars && (
        <div
          aria-hidden
          data-testid="binoculars"
          style={{
            position: 'absolute',
            // Behind the corner controls and the guidance line, not over them.
            zIndex: -1,
            inset: 0,
            pointerEvents: 'none',
            // One wide field rather than two circles: modern binoculars merge
            // into a single oval, and two stacked CSS gradients would simply
            // paint one eyepiece over the other.
            background:
              'radial-gradient(ellipse 41% 52% at 50% 50%, rgba(0,0,0,0) 58%, rgba(0,0,0,0.55) 70%, rgba(0,0,0,0.99) 82%)',
          }}
        />
      )}

      {/*
        The SM-01, in words (spec §12, audit A5).

        §3.2 makes the machine's colour semantic — amber is working, blue is
        transforming, pulsing amber is a fault — and `indicatorColor()` was the
        only place that lived. `displayText()` exists, but it is drawn as a
        texture *inside the canvas*, so it is not a second channel for anybody
        who cannot see the first one.

        Visually hidden rather than shown, because the panel itself is the
        display for everyone who can see it, and a caption repeating what the
        machine already says would be noise on screen. It names the colour as
        well as the state, so the two channels describe the same machine rather
        than two different ones.
      */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="machine-state"
        style={SR_ONLY}
      >
        {machineInWords(ritual.machine)}
      </div>
    </div>
  );
}

/**
 * Off screen, but read aloud.
 *
 * The `clip`/`clip-path` pair rather than `display: none` or `visibility:
 * hidden`, either of which takes the element out of the accessibility tree as
 * well as out of the picture, which is the opposite of what this is for.
 */
const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** What the SM-01's panel and its indicator say, as a sentence. */
function machineInWords(machine: RitualState['machine']): string {
  switch (machine.stage) {
    case 'idle':
      return machine.door > 0.5 ? 'The machine is open and empty.' : 'The machine is ready.';
    case 'loaded':
      return 'It is in. The door is still open.';
    case 'door-closing':
      return 'The door is closing.';
    case 'door-closed':
      return 'The door is shut and not yet latched.';
    case 'latched':
      return machine.confirmed
        ? 'Latched, program confirmed. The lever is up.'
        : 'Latched. No program chosen yet.';
    case 'armed':
      return 'Armed. The lever is up.';
    case 'processing':
      return 'Running. The chamber light is amber.';
    case 'transforming':
      return 'Transforming.';
    case 'freezing':
      return 'Freezing. The chamber light has turned blue.';
    case 'complete':
      return 'Finished. The light is steady.';
    case 'unlatched':
      return 'Unlatched. The door can be opened.';
    case 'opening':
      return 'The door is opening.';
    case 'revealed':
      return 'The door is open. There is a sandwich on the tray.';
    case 'fault':
      return 'Fault. The light is pulsing amber.';
    default:
      return '';
  }
}

/**
 * A control on a bevelled plate, showing a picture rather than a word.
 *
 * The HUD used to be seven blocks of system-font text stacked over the
 * campsite — a lot of reading for something done with a thumb, and a look
 * belonging to no particular game. So the verbs and nouns became sprites, and
 * `label` stopped being what is drawn and became what the button is *called*.
 *
 * It is still called that. The label goes on `aria-label`, so the screen
 * reader path and the keyboard path are exactly as they were: nothing here
 * removes information, it changes which sense carries it. And under high
 * contrast the word comes back on screen underneath the icon, because an
 * icon-only control is worse for low vision and §12 is not satisfied by a
 * screen reader alone.
 *
 * The plate is CSS rather than a sprite on purpose. It has to stretch to fit
 * whatever is on it; a 32-pixel nine-slice would either tile visibly or
 * scale into mush, and a bevel is four lines of box-shadow.
 */
function CornerButton({
  label,
  icon,
  onClick,
  textScale,
  highContrast,
  accent,
  size = 'normal',
  testId,
}: {
  label: string;
  icon?: SpriteName;
  onClick: () => void;
  textScale: number;
  highContrast: boolean;
  accent?: boolean;
  size?: 'normal' | 'large';
  testId?: string;
}): React.ReactElement {
  const scale = size === 'large' ? 2 : 1;
  const pad = (size === 'large' ? 8 : 6) * textScale;
  const showWord = highContrast || icon === undefined;
  return (
    <button
      className="sm-focus"
      onClick={onClick}
      aria-label={label}
      {...(testId ? { 'data-testid': testId } : {})}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 2,
        background: accent
          ? 'linear-gradient(180deg, rgba(255,210,74,0.22), rgba(120,74,10,0.34))'
          : highContrast
            ? '#000'
            : 'linear-gradient(180deg, rgba(46,54,66,0.82), rgba(14,18,24,0.86))',
        color: accent ? TOKENS.amber : highContrast ? '#fff' : 'rgba(232,224,205,0.92)',
        // The bevel: a light top-left lip and a dark bottom-right one, which is
        // the whole of how a plate reads as raised.
        border: highContrast
          ? '2px solid #fff'
          : `1px solid ${accent ? 'rgba(255,210,74,0.55)' : 'rgba(166,179,194,0.34)'}`,
        boxShadow: highContrast
          ? 'none'
          : 'inset 1px 1px 0 rgba(200,215,235,0.20), inset -1px -1px 0 rgba(0,0,0,0.55), 0 1px 3px rgba(0,0,0,0.5)',
        padding: `${pad}px ${pad + (showWord ? 6 : 2) * textScale}px`,
        fontSize: `${11 * textScale}px`,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        borderRadius: 3,
        fontWeight: accent ? 700 : 500,
        lineHeight: 1.1,
      }}
    >
      {icon ? <Sprite name={icon} scale={scale} /> : null}
      {showWord ? <span>{label}</span> : null}
    </button>
  );
}


/**
 * The stamped rule, warming with a held throw.
 *
 * Between the booklet's stamp red and its amber, and nothing else — no third
 * colour, no brightness beyond the palette, and above all no length. It says
 * "you are winding up" and refuses to say how far, which is the difference
 * between a colour and a gauge.
 */
function mixStamp(power: number): string {
  const t = power < 0 ? 0 : power > 1 ? 1 : power;
  const from = [0x8f, 0x3b, 0x2a];
  const to = [0xff, 0xa4, 0x2c];
  const channel = (i: number) => Math.round(from[i]! + (to[i]! - from[i]!) * t);
  return `rgb(${channel(0)}, ${channel(1)}, ${channel(2)})`;
}
