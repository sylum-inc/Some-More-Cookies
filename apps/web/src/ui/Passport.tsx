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
}

export function Passport({ passport, onClose, onLink, textScale }: PassportProps): React.ReactElement {
  const px = (n: number) => `${n * textScale}px`;

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
                  <img
                    src={photo.dataUrl}
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
