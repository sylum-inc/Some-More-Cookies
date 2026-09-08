/**
 * The Campfire Passport (spec §6.2).
 *
 * A field journal, a campground registration booklet, a disposable photo
 * album, a scrapbook, and a PS1 memory card — explicitly *not* a card grid or
 * a dashboard. It is opened, never landed on.
 */

import { provenanceLines, type SandwichRecord } from '@somemore/sim';
import { CUT_MARK_PX, FONT_STACK, TOKENS, px as uiPx, typePx, useScrollCut } from './styles.js';
import type { PassportState } from '../state/store.js';
import { useDialog } from './useDialog.js';

export interface PassportProps {
  passport: PassportState;
  onClose: () => void;
  onLink: (provider: 'apple' | 'google' | 'email') => void;
  textScale: number;
  /** The campsite this Passport is open at, if it is open at one. */
  campsiteSeed?: string;
  /**
   * Opens the code panel.
   *
   * Here rather than on the HUD because this is where rewards already live and
   * because a wrapper is something you have in your hand between things — not
   * something the campfire should be asking you about.
   */
  onAddCode?: () => void;
}

export function Passport({
  passport,
  onClose,
  onLink,
  textScale,
  campsiteSeed,
  onAddCode,
}: PassportProps): React.ReactElement {
  // Focus into the panel, trapped inside it, and back where it came from.
  const dialog = useDialog();
  // Whether anything is below the cut. "Keep this passport" was the line this
  // booklet was being sliced through, with nothing on the page to say so.
  const cut = useScrollCut<HTMLDivElement>();
  const px = (n: number) => uiPx(n, textScale);
  const tp = (n: number) => typePx(n, textScale);
  const here = campsiteSeed === undefined ? undefined : passport.campsites[campsiteSeed];

  return (
    <div
      className="sm-overlay"
      role="dialog"
      aria-label="Campfire Passport"
      onClick={onClose}
      {...dialog.props}
    >
      <div
        className="sm-panel sm-panel-tall"
        data-more={cut.more}
        onClick={(event) => event.stopPropagation()}
        style={{
          /*
            Weathered paper, not a card surface — and *screened* paper, which
            it had stopped being. This override replaced `.sm-panel`'s whole
            background, halftone included, so the one panel a player is meant
            to sit and read was the one flat cream field in the interface. The
            two crossed 3px gradients come first now and the weathering sits
            under them.
          */
          background: `
            repeating-linear-gradient(0deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
            repeating-linear-gradient(90deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
            radial-gradient(ellipse at 20% 10%, rgba(255,252,240,0.9), transparent 60%),
            radial-gradient(ellipse at 85% 80%, rgba(198,182,150,0.5), transparent 55%),
            ${TOKENS.paper}`,
          width: 'min(760px, 94vw)',
          boxShadow: '0 18px 60px rgba(0,0,0,0.65), inset 0 0 60px rgba(150,130,95,0.18)',
        }}
      >
        {/*
          Outside the scroll region. A booklet this long is read to the end,
          and the way to shut it used to scroll off the top with the cover.
        */}
        {/* No glyph inside it: the X is two 2px bars drawn by `.sm-close`. */}
        <button
          className="sm-focus sm-close"
          onClick={onClose}
          aria-label="Close passport"
          style={{
            position: 'absolute',
            top: px(10),
            right: px(12),
            zIndex: 3,
            width: px(22),
            height: px(22),
            color: TOKENS.inkSoft,
          }}
        />

        {/* The extra bottom padding is the cut mark's twenty fixed pixels: the
            last line of the last section has to be able to scroll clear of it,
            or "Keep this passport" is the one thing on the page nobody can read
            cleanly. */}
        <div ref={cut.ref} className="sm-panel-scroll" style={{ padding: px(28), paddingBottom: `${Math.round(28 * textScale) + CUT_MARK_PX}px` }}>
          {/* Cover block, like a registration booklet */}
          <header style={{ borderBottom: `2px solid ${TOKENS.ink}`, paddingBottom: px(12), marginBottom: px(16) }}>
            <div style={{ fontFamily: FONT_STACK.mono, fontSize: tp(10), letterSpacing: '0.3em', color: TOKENS.inkSoft }}>
              SOME MORE · CAMPGROUND REGISTRATION
            </div>
            <h1 className="sm-stamp" style={{ fontSize: tp(21), margin: `${px(6)} 0 0` }}>
              Campfire Passport
            </h1>
            <div style={{ fontFamily: FONT_STACK.hand, fontSize: tp(15), color: TOKENS.inkSoft, marginTop: px(4) }}>
              {passport.displayName} · issued {new Date(passport.createdAt).toLocaleDateString()}
            </div>
          </header>

          {/* Stamps — a row of inked marks, not achievement tiles */}
          <section style={{ marginBottom: px(20) }}>
            <SectionLabel textScale={textScale}>Stamps</SectionLabel>
            {passport.stamps.length === 0 ? (
              <Empty textScale={textScale}>No stamps yet. The first one comes with the first sandwich.</Empty>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: px(10), marginTop: px(8) }}>
                {passport.stamps.map((stamp) => (
                  <Stamp key={stamp} id={stamp} textScale={textScale} />
                ))}
              </div>
            )}
          </section>

          {/* Polaroids */}
          <section style={{ marginBottom: px(20) }}>
            <SectionLabel textScale={textScale}>Photographs</SectionLabel>
            {passport.photos.length === 0 ? (
              <Empty textScale={textScale}>Nothing developed yet.</Empty>
            ) : (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: px(14), marginTop: px(10) }}>
                {passport.photos.map((photo) => (
                  <figure
                    key={photo.id}
                    style={{
                      margin: 0,
                      background: '#fdfbf4',
                      padding: `${px(8)} ${px(8)} ${px(26)}`,
                      boxShadow: '0 4px 14px rgba(0,0,0,0.28)',
                      transform: `rotate(${(hash(photo.id) % 10) - 5}deg)`,
                      width: px(168),
                    }}
                  >
                    {/*
                      The local copy while there is one, then the stored bytes.
                      A photograph whose data URL has been dropped because it
                      reached object storage is still a photograph on the page —
                      that is the whole point of dropping it.
                    */}
                    <img
                      src={photo.dataUrl || photo.url}
                      alt={photo.caption}
                      style={{ width: '100%', display: 'block', imageRendering: 'pixelated' }}
                    />
                    <figcaption
                      style={{
                        fontFamily: FONT_STACK.hand,
                        fontSize: tp(12),
                        color: TOKENS.ink,
                        marginTop: px(7),
                        lineHeight: 1.25,
                      }}
                    >
                      {photo.caption}
                    </figcaption>
                  </figure>
                ))}
              </div>
            )}
          </section>

          {/*
            Ticket stubs.

            What came off a wrapper or an event card. The reward itself is the
            account's and was server-validated when it was granted (spec §11);
            this is the stub, so it still reads at a campsite with no signal.
            The button is here and not on the HUD for the same reason the whole
            section is: it is a thing you do between things.
          */}
          <section style={{ marginBottom: px(20) }}>
            <SectionLabel textScale={textScale}>Ticket stubs</SectionLabel>
            {(passport.redeemedCodes ?? []).length === 0 ? (
              <Empty textScale={textScale}>Nothing scanned yet.</Empty>
            ) : (
              <div style={{ marginTop: px(10), display: 'grid', gap: px(8) }}>
                {(passport.redeemedCodes ?? []).slice(0, 10).map((stub) => (
                  <div
                    key={stub.id}
                    data-testid="passport-stub"
                    style={{
                      background: 'rgba(255,253,246,0.72)',
                      borderLeft: `4px solid ${TOKENS.stamp}`,
                      padding: px(10),
                      fontFamily: FONT_STACK.mono,
                      fontSize: tp(11),
                      color: TOKENS.ink,
                      lineHeight: 1.6,
                    }}
                  >
                    <div style={{ fontFamily: FONT_STACK.hand, fontSize: tp(14) }}>{stub.awarded}</div>
                    <div style={{ color: TOKENS.inkSoft }}>
                      {new Date(stub.redeemedAt).toLocaleDateString(undefined, { dateStyle: 'medium' })}
                    </div>
                  </div>
                ))}
              </div>
            )}
            {onAddCode !== undefined && (
              <button
                className="sm-focus"
                data-testid="passport-add-code"
                onClick={onAddCode}
                style={{
                  marginTop: px(10),
                  background: 'transparent',
                  border: `2px solid ${TOKENS.ink}`,
                  color: TOKENS.ink,
                  padding: `${px(7)} ${px(13)}`,
                  fontSize: tp(12),
                  letterSpacing: '0.06em',
                  borderRadius: 0,
                }}
              >
                Add a code from a wrapper
              </button>
            )}
          </section>

          {/* Sandwich records — receipts, not a leaderboard */}
          <section style={{ marginBottom: px(20) }}>
            <SectionLabel textScale={textScale}>Record of sandwiches</SectionLabel>
            {passport.entries.length === 0 ? (
              <Empty textScale={textScale}>None yet.</Empty>
            ) : (
              <div style={{ marginTop: px(10), display: 'grid', gap: px(12) }}>
                {passport.entries.slice(0, 12).map((entry) => (
                  <SandwichReceipt key={entry.id} sandwich={entry.sandwich} savedAt={entry.savedAt} textScale={textScale} />
                ))}
              </div>
            )}
          </section>

          {/*
            This campsite.

            The one page that is *about a place* rather than about the player.
            It counts visits, because an ordinal is not a score — "the fourth
            time" is a fact about a night, not a rating of it. There is no
            denominator anywhere on it: no animals-seen-of-total, no
            secrets-found-of-total, no completion. The significance value that
            decided which of these things were worth keeping is never stored and
            never shown (§6.4).
          */}
          {here && here.visits > 1 && (
            <section style={{ marginBottom: px(20) }}>
              <SectionLabel textScale={textScale}>This campsite</SectionLabel>
              <p style={{ fontSize: tp(13), color: TOKENS.ink, margin: `${px(8)} 0 0`, lineHeight: 1.6 }}>
                {visitLine(here.visits)}
              </p>

              {here.sightings.length > 0 && (
                <p style={{ fontSize: tp(13), color: TOKENS.inkSoft, margin: `${px(8)} 0 0`, lineHeight: 1.6 }}>
                  Seen here: {here.sightings.slice(0, 6).join(', ')}.
                </p>
              )}

              {here.secrets.length > 0 && (
                <div style={{ marginTop: px(10) }}>
                  {here.secrets.slice(0, 6).map((record) => (
                    <p
                      key={record.secretId}
                      style={{
                        fontFamily: FONT_STACK.hand,
                        fontSize: tp(14),
                        color: TOKENS.ink,
                        margin: `${px(4)} 0`,
                        lineHeight: 1.5,
                      }}
                    >
                      {record.evidence ?? record.secretId.replace(/-/g, ' ')}
                    </p>
                  ))}
                </div>
              )}

              {here.traces.filter((trace) => trace.disposition === 'landmark').length > 0 && (
                <p style={{ fontSize: tp(12), color: TOKENS.inkSoft, margin: `${px(10)} 0 0`, fontStyle: 'italic' }}>
                  Some of it is still out there.
                </p>
              )}
            </section>
          )}

          {/* Account linking, offered without pressure */}
          <section style={{ borderTop: `2px dashed ${TOKENS.inkSoft}`, paddingTop: px(14) }}>
            <SectionLabel textScale={textScale}>Keep this passport</SectionLabel>
            {passport.linkedProvider === 'none' ? (
              <>
                <p style={{ fontSize: tp(13), color: TOKENS.inkSoft, margin: `${px(6)} 0 ${px(10)}`, lineHeight: 1.5 }}>
                  This passport lives on this device. Linking an account keeps everything in it — nothing is lost, and
                  nothing changes about how you play.
                </p>
                <div style={{ display: 'flex', gap: px(8), flexWrap: 'wrap' }}>
                  {(['apple', 'google', 'email'] as const).map((provider) => (
                    <button
                      key={provider}
                      className="sm-focus"
                      onClick={() => onLink(provider)}
                      style={{
                        background: 'transparent',
                        border: `2px solid ${TOKENS.ink}`,
                        color: TOKENS.ink,
                        padding: `${px(7)} ${px(13)}`,
                        fontSize: tp(12),
                        letterSpacing: '0.06em',
                        textTransform: 'capitalize',
                        borderRadius: 0,
                      }}
                    >
                      {provider}
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <p style={{ fontSize: tp(13), color: TOKENS.inkSoft }}>
                Linked with {passport.linkedProvider}.
              </p>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}

/**
 * One inked mark in the booklet.
 *
 * It was a `border-radius: 50%` on a div, and an art grade said so in exactly
 * those words: "as drawn it is a border-radius". It was right — a perfect
 * two-pixel circle at a degree and a half of rotation is a CSS shape, not
 * something a rubber die pressed onto paper. Three things separate the two,
 * and none of them is an image file (ADR-0002):
 *
 *   ROTATED   four to seven degrees, and never less. The old formula was
 *             `(hash % 16) - 8`, which produces zero and one as readily as
 *             seven, so most stamps landed square and read as a mistake. The
 *             sign comes from the hash too, so a page of them tilts both ways
 *             like a booklet stamped by hand on different days.
 *   BROKEN    the ring is an SVG circle with a dash pattern derived from the
 *             stamp's own name, so the die lifted in four places. A closed
 *             ring is a border however it is drawn.
 *   MOTTLED   the whole mark is masked by a 2px checker at 0.68 alpha — the
 *             same printed screen the panels and the sliders use — with one
 *             hashed patch of heavier loss over it, which is where the ink
 *             did not take.
 *
 * Everything variable about it is a hash of the stamp id, so the same stamp is
 * the same mark every time the booklet is opened. Presentation may use a wall
 * clock and `Math.random` (ADR-0001); a mark that moved every render would be
 * a page that will not sit still.
 */
function Stamp({ id, textScale }: { id: string; textScale: number }): React.ReactElement {
  const seed = hash(id);
  const size = Math.round(76 * textScale);
  // Four to seven degrees, either way. `% 4` gives 0..3, so +4 gives 4..7.
  const tilt = (((seed >>> 3) % 4) + 4) * (seed % 2 === 0 ? 1 : -1);
  const r = size / 2 - 5;
  const circumference = 2 * Math.PI * r;
  // Four gaps round the ring. The dash array alternates ink and air; the
  // offset rotates the whole pattern so two stamps never break in the same
  // places.
  const gap = circumference / 26;
  const run = circumference / 4 - gap;
  const wear = `radial-gradient(ellipse at ${20 + (seed % 40)}% ${15 + ((seed >>> 5) % 50)}%, rgba(0,0,0,0.3) 0 8%, #000 34%)`;
  const screen = 'repeating-conic-gradient(#000 0% 25%, rgba(0,0,0,0.68) 0% 50%)';
  return (
    <div
      data-testid="passport-stamp"
      style={{
        position: 'relative',
        width: size,
        height: size,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        textAlign: 'center',
        color: TOKENS.stamp,
        fontFamily: FONT_STACK.mono,
        fontSize: typePx(10, textScale),
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        transform: `rotate(${tilt}deg)`,
        opacity: 0.86,
        WebkitMaskImage: `${wear}, ${screen}`,
        maskImage: `${wear}, ${screen}`,
        WebkitMaskSize: '100% 100%, 4px 4px',
        maskSize: '100% 100%, 4px 4px',
        WebkitMaskComposite: 'source-in',
        maskComposite: 'intersect',
      }}
    >
      {/* Two rings a few pixels apart, because a die has an outer edge and an
          inner one and a single stroke reads as a hoop. */}
      <svg aria-hidden width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ position: 'absolute', inset: 0 }}>
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={TOKENS.stamp}
          strokeWidth={3}
          strokeDasharray={`${run.toFixed(2)} ${gap.toFixed(2)}`}
          strokeDashoffset={(seed % Math.max(1, Math.round(circumference))).toFixed(2)}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r - 4}
          fill="none"
          stroke={TOKENS.stamp}
          strokeWidth={2}
          strokeDasharray={`${(run * 0.7).toFixed(2)} ${(gap * 1.7).toFixed(2)}`}
          strokeDashoffset={((seed >>> 7) % Math.max(1, Math.round(circumference))).toFixed(2)}
        />
      </svg>
      <span style={{ position: 'relative', padding: `0 ${uiPx(8, textScale)}` }}>{id.replace('stamp-', '')}</span>
    </div>
  );
}

function SandwichReceipt({
  sandwich,
  savedAt,
  textScale,
}: {
  sandwich: SandwichRecord;
  savedAt: number;
  textScale: number;
}): React.ReactElement {
  const px = (n: number) => uiPx(n, textScale);
  const tp = (n: number) => typePx(n, textScale);
  return (
    <article
      style={{
        background: 'rgba(255,253,246,0.72)',
        borderLeft: `4px solid ${TOKENS.stamp}`,
        padding: px(12),
        fontFamily: FONT_STACK.mono,
        fontSize: tp(11),
        color: TOKENS.ink,
        lineHeight: 1.6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: px(10), flexWrap: 'wrap' }}>
        <strong style={{ letterSpacing: '0.14em' }}>{sandwich.class.toUpperCase()}</strong>
        <span style={{ color: TOKENS.inkSoft }}>
          {new Date(savedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}
        </span>
      </div>
      <div style={{ fontFamily: FONT_STACK.hand, fontSize: tp(14), margin: `${px(4)} 0 ${px(6)}` }}>
        {sandwich.caption}
      </div>
      {provenanceLines(sandwich).map((line) => (
        <div key={line} style={{ color: TOKENS.inkSoft }}>
          {line}
        </div>
      ))}
    </article>
  );
}

/**
 * How many times you have been here, said the way a person would.
 *
 * Never a number in a box. "The fourth time" is a sentence; "Visits: 4" is a
 * statistic, and a statistic about a campsite turns it into a record card.
 */
export function visitLine(visits: number): string {
  if (visits <= 1) return 'The first night here.';
  if (visits === 2) return 'You have been here once before.';
  if (visits === 3) return 'The third time at this fire.';
  if (visits < 8) return `You keep coming back to this one.`;
  if (visits < 20) return 'This one is yours by now.';
  return 'You know this place with your eyes shut.';
}

function SectionLabel({ children, textScale }: { children: React.ReactNode; textScale: number }): React.ReactElement {
  return (
    <h2
      style={{
        fontFamily: FONT_STACK.mono,
        fontSize: typePx(10, textScale),
        letterSpacing: '0.26em',
        textTransform: 'uppercase',
        color: TOKENS.inkSoft,
        margin: 0,
      }}
    >
      {children}
    </h2>
  );
}

function Empty({ children, textScale }: { children: React.ReactNode; textScale: number }): React.ReactElement {
  return (
    <p style={{ fontFamily: FONT_STACK.hand, fontSize: typePx(14, textScale), color: TOKENS.inkSoft, margin: `${uiPx(6, textScale)} 0 0` }}>
      {children}
    </p>
  );
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}
