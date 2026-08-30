/**
 * The Campfire Passport (spec §6.2).
 *
 * A field journal, a campground registration booklet, a disposable photo
 * album, a scrapbook, and a PS1 memory card — explicitly *not* a card grid or
 * a dashboard. It is opened, never landed on.
 */

import { provenanceLines, type SandwichRecord } from '@somemore/sim';
import { FONT_STACK, TOKENS } from './styles.js';
import type { PassportState } from '../state/store.js';

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
  const px = (n: number) => `${n * textScale}px`;
  const here = campsiteSeed === undefined ? undefined : passport.campsites[campsiteSeed];

  return (
    <div className="sm-overlay" role="dialog" aria-label="Campfire Passport" onClick={onClose}>
      <div
        className="sm-panel"
        onClick={(event) => event.stopPropagation()}
        style={{
          // Weathered paper, not a card surface.
          background: `
            radial-gradient(ellipse at 20% 10%, rgba(255,252,240,0.9), transparent 60%),
            radial-gradient(ellipse at 85% 80%, rgba(198,182,150,0.5), transparent 55%),
            ${TOKENS.paper}`,
          padding: px(28),
          width: 'min(760px, 94vw)',
          boxShadow: '0 18px 60px rgba(0,0,0,0.65), inset 0 0 60px rgba(150,130,95,0.18)',
        }}
      >
        <button
          className="sm-focus"
          onClick={onClose}
          aria-label="Close passport"
          style={{
            position: 'absolute',
            top: px(10),
            right: px(12),
            background: 'transparent',
            border: 'none',
            fontSize: px(22),
            color: TOKENS.inkSoft,
            lineHeight: 1,
          }}
        >
          ×
        </button>

        {/* Cover block, like a registration booklet */}
        <header style={{ borderBottom: `2px solid ${TOKENS.ink}`, paddingBottom: px(12), marginBottom: px(16) }}>
          <div style={{ fontFamily: FONT_STACK.mono, fontSize: px(10), letterSpacing: '0.3em', color: TOKENS.inkSoft }}>
            SOME MORE · CAMPGROUND REGISTRATION
          </div>
          <h1 style={{ fontFamily: FONT_STACK.serif, fontSize: px(30), margin: `${px(6)} 0 0`, color: TOKENS.ink, letterSpacing: '0.02em' }}>
            Campfire Passport
          </h1>
          <div style={{ fontFamily: FONT_STACK.hand, fontSize: px(15), color: TOKENS.inkSoft, marginTop: px(4) }}>
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
                <div
                  key={stamp}
                  style={{
                    border: `2px solid ${TOKENS.stamp}`,
                    color: TOKENS.stamp,
                    borderRadius: '50%',
                    width: px(76),
                    height: px(76),
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    textAlign: 'center',
                    fontFamily: FONT_STACK.mono,
                    fontSize: px(10),
                    letterSpacing: '0.08em',
                    textTransform: 'uppercase',
                    transform: `rotate(${(hash(stamp) % 16) - 8}deg)`,
                    opacity: 0.82,
                  }}
                >
                  {stamp.replace('stamp-', '')}
                </div>
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
                      fontSize: px(12),
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
                    borderLeft: `3px solid ${TOKENS.stamp}`,
                    padding: px(10),
                    fontFamily: FONT_STACK.mono,
                    fontSize: px(11),
                    color: TOKENS.ink,
                    lineHeight: 1.6,
                  }}
                >
                  <div style={{ fontFamily: FONT_STACK.hand, fontSize: px(14) }}>{stub.awarded}</div>
                  <div style={{ color: TOKENS.inkSoft }}>
                    {stub.batchId} · {new Date(stub.redeemedAt).toLocaleDateString()}
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
                border: `1px solid ${TOKENS.ink}`,
                color: TOKENS.ink,
                padding: `${px(7)} ${px(13)}`,
                fontSize: px(12),
                letterSpacing: '0.06em',
                borderRadius: 2,
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
            <p style={{ fontSize: px(13), color: TOKENS.ink, margin: `${px(8)} 0 0`, lineHeight: 1.6 }}>
              {visitLine(here.visits)}
            </p>

            {here.sightings.length > 0 && (
              <p style={{ fontSize: px(13), color: TOKENS.inkSoft, margin: `${px(8)} 0 0`, lineHeight: 1.6 }}>
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
                      fontSize: px(14),
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
              <p style={{ fontSize: px(12), color: TOKENS.inkSoft, margin: `${px(10)} 0 0`, fontStyle: 'italic' }}>
                Some of it is still out there.
              </p>
            )}
          </section>
        )}

        {/* Account linking, offered without pressure */}
        <section style={{ borderTop: `1px dashed ${TOKENS.inkSoft}`, paddingTop: px(14) }}>
          <SectionLabel textScale={textScale}>Keep this passport</SectionLabel>
          {passport.linkedProvider === 'none' ? (
            <>
              <p style={{ fontSize: px(13), color: TOKENS.inkSoft, margin: `${px(6)} 0 ${px(10)}`, lineHeight: 1.5 }}>
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
                      border: `1px solid ${TOKENS.ink}`,
                      color: TOKENS.ink,
                      padding: `${px(7)} ${px(13)}`,
                      fontSize: px(12),
                      letterSpacing: '0.06em',
                      textTransform: 'capitalize',
                      borderRadius: 2,
                    }}
                  >
                    {provider}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <p style={{ fontSize: px(13), color: TOKENS.inkSoft }}>
              Linked with {passport.linkedProvider}.
            </p>
          )}
        </section>
      </div>
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
  const px = (n: number) => `${n * textScale}px`;
  return (
    <article
      style={{
        background: 'rgba(255,253,246,0.72)',
        borderLeft: `3px solid ${TOKENS.stamp}`,
        padding: px(12),
        fontFamily: FONT_STACK.mono,
        fontSize: px(11),
        color: TOKENS.ink,
        lineHeight: 1.6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: px(10), flexWrap: 'wrap' }}>
        <strong style={{ letterSpacing: '0.14em' }}>{sandwich.class.toUpperCase()}</strong>
        <span style={{ color: TOKENS.inkSoft }}>{new Date(savedAt).toLocaleString()}</span>
      </div>
      <div style={{ fontFamily: FONT_STACK.hand, fontSize: px(14), margin: `${px(4)} 0 ${px(6)}` }}>
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
        fontSize: `${10 * textScale}px`,
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
    <p style={{ fontFamily: FONT_STACK.hand, fontSize: `${14 * textScale}px`, color: TOKENS.inkSoft, margin: `${6 * textScale}px 0 0` }}>
      {children}
    </p>
  );
}

function hash(value: string): number {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
}
