/**
 * The Some More terminal (spec §11).
 *
 * Commerce is subordinate to the experience. No purchase surface exists
 * before the product reveal, and the fiction is maintained through this
 * terminal until conventional checkout UI is genuinely required.
 *
 * Launch catalogue: the flagship roasted-marshmallow sandwich only.
 */

import { useEffect, useState } from 'react';
import { provenanceLines, type SandwichRecord } from '@somemore/sim';
import { FONT_STACK, TOKENS } from './styles.js';

export interface TerminalProps {
  sandwich: SandwichRecord;
  onClose: () => void;
  textScale: number;
}

type Step = 'terminal' | 'checkout' | 'unavailable';

export function Terminal({ sandwich, onClose, textScale }: TerminalProps): React.ReactElement {
  const [step, setStep] = useState<Step>('terminal');
  const [lines, setLines] = useState<string[]>([]);
  const px = (n: number) => `${n * textScale}px`;

  // The terminal prints its readout a line at a time, the way an appliance
  // with a thermal printer would.
  useEffect(() => {
    const source = [
      'SOME MORE · ORDER TERMINAL',
      '',
      `UNIT ${sandwich.machine.serial}`,
      `ITEM SM-CLASSIC · ROASTED MARSHMALLOW ICE CREAM SANDWICH`,
      '',
      'GRAHAM CRACKER COOKIE',
      'CHOCOLATE',
      'ROASTED MARSHMALLOW ICE CREAM',
      'CHOCOLATE',
      'GRAHAM CRACKER COOKIE',
      '',
      ...provenanceLines(sandwich),
      '',
      'THIS ONE WAS MADE TONIGHT.',
      'WE CAN MAKE YOU A REAL ONE.',
    ];
    setLines([]);
    let index = 0;
    const timer = setInterval(() => {
      index++;
      setLines(source.slice(0, index));
      if (index >= source.length) clearInterval(timer);
    }, 45);
    return () => clearInterval(timer);
  }, [sandwich]);

  return (
    <div className="sm-overlay" role="dialog" aria-label="Some More order terminal" onClick={onClose}>
      <div
        className="sm-panel"
        onClick={(event) => event.stopPropagation()}
        style={{
          width: 'min(560px, 94vw)',
          background: '#0d1512',
          color: '#5affbe',
          fontFamily: FONT_STACK.mono,
          padding: px(24),
          border: '1px solid #1f3a30',
          boxShadow: '0 0 60px rgba(90,255,190,0.08), 0 18px 60px rgba(0,0,0,0.7)',
        }}
      >
        <button
          className="sm-focus"
          onClick={onClose}
          aria-label="Close terminal"
          style={{ position: 'absolute', top: px(8), right: px(12), background: 'transparent', border: 'none', color: '#3c8f74', fontSize: px(20) }}
        >
          ×
        </button>

        {step === 'terminal' && (
          <>
            <pre
              style={{
                margin: 0,
                fontSize: px(12),
                lineHeight: 1.75,
                whiteSpace: 'pre-wrap',
                minHeight: px(340),
              }}
            >
              {lines.join('\n')}
              <span style={{ opacity: 0.7 }}>▊</span>
            </pre>
            <div style={{ display: 'flex', gap: px(10), marginTop: px(18), flexWrap: 'wrap' }}>
              <TerminalButton onClick={() => setStep('checkout')} textScale={textScale} primary>
                MAKE THIS REAL
              </TerminalButton>
              <TerminalButton onClick={onClose} textScale={textScale}>
                NOT NOW
              </TerminalButton>
            </div>
          </>
        )}

        {step === 'checkout' && (
          <>
            <div style={{ fontSize: px(12), lineHeight: 1.8 }}>
              <div style={{ letterSpacing: '0.2em', marginBottom: px(14) }}>ORDER</div>
              <Row label="ITEM" value="Roasted Marshmallow Ice Cream Sandwich" textScale={textScale} />
              <Row label="QTY" value="1" textScale={textScale} />
              <Row label="MADE AT" value={sandwich.machine.serial} textScale={textScale} />
              <Row label="CLASS" value={sandwich.class} textScale={textScale} />
              <div
                style={{
                  borderTop: '1px dashed #1f3a30',
                  marginTop: px(14),
                  paddingTop: px(14),
                  color: '#8fd4ff',
                }}
              >
                {/* Being honest about the blocker rather than faking a
                    checkout. A fake payment sheet would be worse than none. */}
                <div style={{ letterSpacing: '0.16em', marginBottom: px(8) }}>PAYMENT UNAVAILABLE</div>
                <p style={{ margin: 0, lineHeight: 1.7, color: '#6fa9c9' }}>
                  This build has no payment processor configured. The order domain, the Stripe adapter, idempotency
                  and the fulfilment state machine are all implemented and tested — they are waiting on live
                  credentials, not on code.
                </p>
                <p style={{ marginTop: px(12), marginBottom: 0, color: '#3c8f74' }}>
                  Apple Pay · Google Pay · Card
                </p>
              </div>
            </div>
            <div style={{ display: 'flex', gap: px(10), marginTop: px(18) }}>
              <TerminalButton onClick={() => setStep('terminal')} textScale={textScale}>
                BACK
              </TerminalButton>
              <TerminalButton onClick={onClose} textScale={textScale}>
                CLOSE
              </TerminalButton>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({ label, value, textScale }: { label: string; value: string; textScale: number }): React.ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: `${12 * textScale}px` }}>
      <span style={{ color: '#3c8f74' }}>{label}</span>
      <span style={{ textAlign: 'right' }}>{value}</span>
    </div>
  );
}

function TerminalButton({
  children,
  onClick,
  textScale,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  textScale: number;
  primary?: boolean;
}): React.ReactElement {
  return (
    <button
      className="sm-focus"
      onClick={onClick}
      style={{
        background: primary ? '#5affbe' : 'transparent',
        color: primary ? '#06120d' : '#5affbe',
        border: '1px solid #5affbe',
        padding: `${9 * textScale}px ${16 * textScale}px`,
        fontFamily: FONT_STACK.mono,
        fontSize: `${12 * textScale}px`,
        letterSpacing: '0.14em',
        fontWeight: primary ? 700 : 400,
      }}
    >
      {children}
    </button>
  );
}

/** The colour token re-export keeps the terminal palette discoverable. */
export const TERMINAL_ACCENT = TOKENS.ice;
