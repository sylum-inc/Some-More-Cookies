/**
 * The Some More terminal (spec §11).
 *
 * Commerce is subordinate to the experience. No purchase surface exists
 * before the product reveal, and the fiction is maintained through this
 * terminal until conventional checkout UI is genuinely required.
 *
 * Launch catalogue: the flagship roasted-marshmallow sandwich only.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { provenanceLines, type SandwichRecord } from '@somemore/sim';
import type { Address } from '@somemore/protocol';
import { FONT_STACK, TOKENS } from './styles.js';
import { OrderFlow, formatMoney, type OrderFlowState } from '../net/order.js';
import type { SyncEngine } from '../net/sync.js';
import { useDialog } from './useDialog.js';

export interface TerminalProps {
  sandwich: SandwichRecord;
  onClose: () => void;
  textScale: number;
  /**
   * The seam to the service. Optional: a build with no service still shows the
   * provenance printout, which is the part that matters, and says plainly that
   * there is nowhere to send an order.
   */
  sync?: SyncEngine | null;
}

type Step = 'terminal' | 'checkout';

/** A blank shipping form. Nothing here is remembered between sessions. */
function emptyAddress(): Address {
  return {
    name: '',
    line1: '',
    line2: null,
    city: '',
    region: '',
    postalCode: '',
    country: 'US',
    phone: null,
  };
}

export function Terminal({ sandwich, onClose, textScale, sync }: TerminalProps): React.ReactElement {
  // Focus into the panel, trapped inside it, and back where it came from.
  const dialog = useDialog();
  const [step, setStep] = useState<Step>('terminal');
  const [lines, setLines] = useState<string[]>([]);
  const [address, setAddress] = useState<Address>(emptyAddress);
  const [email, setEmail] = useState('');
  const px = (n: number) => `${n * textScale}px`;

  // The flow is built when the terminal opens and thrown away when it closes:
  // no commerce object exists anywhere in the product before the reveal (§11).
  const flow = useMemo(() => (sync ? new OrderFlow(sync.api) : null), [sync]);
  const [order, setOrder] = useState<OrderFlowState | null>(() => flow?.state ?? null);

  useEffect(() => {
    if (!flow) return;
    setOrder(flow.state);
    return flow.subscribe(setOrder);
  }, [flow]);

  const startOrder = useCallback(() => {
    setStep('checkout');
    if (!flow) return;
    void (async () => {
      await sync?.ensureAccount();
      await flow.begin(sandwich.id);
    })();
  }, [flow, sync, sandwich.id]);

  const addressComplete =
    address.name.trim() !== '' &&
    address.line1.trim() !== '' &&
    address.city.trim() !== '' &&
    address.postalCode.trim() !== '' &&
    address.country.trim().length === 2;

  // The terminal prints its readout a line at a time, the way an appliance
  // with a thermal printer would.
  useEffect(() => {
    const source = [
      'SOME MORE · ORDER TERMINAL',
      '',
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
    <div
      className="sm-overlay"
      role="dialog"
      aria-label="Some More order terminal"
      onClick={onClose}
      {...dialog.props}
    >
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
              <TerminalButton onClick={startOrder} textScale={textScale} primary>
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
              <Row
                label="ITEM"
                value={order?.product?.name ?? 'Roasted Marshmallow Ice Cream Sandwich'}
                textScale={textScale}
              />
              <Row label="QTY" value="1" textScale={textScale} />
              <Row label="MADE AT" value={sandwich.machine.serial} textScale={textScale} />
              <Row label="CLASS" value={sandwich.class} textScale={textScale} />

              {order?.stage === 'loading' && <Status textScale={textScale}>CONTACTING THE DEPOT…</Status>}

              {/* Where to send it. A shipping form, because at this point a
                  shipping form is genuinely what is required (§11). */}
              {(order?.stage === 'address' || order?.stage === 'quoting' || order?.stage === 'quoted') && (
                <div style={{ marginTop: px(16), borderTop: '1px dashed #1f3a30', paddingTop: px(14) }}>
                  <div style={{ letterSpacing: '0.16em', marginBottom: px(10) }}>WHERE SHOULD WE SEND IT?</div>
                  <Field label="NAME" value={address.name} textScale={textScale}
                    onChange={(v) => setAddress({ ...address, name: v })} />
                  <Field label="ADDRESS" value={address.line1} textScale={textScale}
                    onChange={(v) => setAddress({ ...address, line1: v })} />
                  <Field label="CITY" value={address.city} textScale={textScale}
                    onChange={(v) => setAddress({ ...address, city: v })} />
                  <Field label="REGION" value={address.region} textScale={textScale}
                    onChange={(v) => setAddress({ ...address, region: v })} />
                  <Field label="POSTCODE" value={address.postalCode} textScale={textScale}
                    onChange={(v) => setAddress({ ...address, postalCode: v })} />
                  <Field label="COUNTRY" value={address.country} textScale={textScale}
                    onChange={(v) => setAddress({ ...address, country: v.toUpperCase().slice(0, 2) })} />
                  <Field label="EMAIL" value={email} textScale={textScale} onChange={setEmail} />
                </div>
              )}

              {/* Rewards, shown only when there are any. A terminal that
                  advertises an empty rewards section is advertising. */}
              {order && order.rewards.length > 0 && order.stage === 'address' && (
                <div style={{ marginTop: px(14), borderTop: '1px dashed #1f3a30', paddingTop: px(14) }}>
                  <div style={{ letterSpacing: '0.16em', marginBottom: px(8) }}>YOU HAVE</div>
                  {order.rewards.map((grant) => (
                    <div
                      key={grant.id}
                      style={{ display: 'flex', justifyContent: 'space-between', gap: px(10), marginBottom: px(6) }}
                    >
                      <span style={{ color: '#5affbe' }}>{grant.rewardCode}</span>
                      <button
                        className="sm-focus"
                        onClick={() => void flow?.redeem(grant.id)}
                        disabled={order.redeemed.includes(grant.id)}
                        style={{
                          background: 'transparent',
                          border: '1px solid #1f3a30',
                          color: order.redeemed.includes(grant.id) ? '#3c8f74' : '#5affbe',
                          fontFamily: FONT_STACK.mono,
                          fontSize: px(11),
                          padding: `${px(3)} ${px(9)}`,
                          cursor: order.redeemed.includes(grant.id) ? 'default' : 'pointer',
                        }}
                      >
                        {order.redeemed.includes(grant.id) ? 'APPLIED' : 'USE IT'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Real totals, from the service. Nothing here is computed here. */}
              {order?.quote && (
                <div style={{ marginTop: px(14), borderTop: '1px dashed #1f3a30', paddingTop: px(14) }}>
                  <Row label="SUBTOTAL" value={formatMoney(order.quote.subtotal)} textScale={textScale} />
                  <Row label="SHIPPING" value={formatMoney(order.quote.shipping.amount)} textScale={textScale} />
                  <Row label="TAX" value={formatMoney(order.quote.tax.total)} textScale={textScale} />
                  <Row label="TOTAL" value={formatMoney(order.quote.total)} textScale={textScale} />
                </div>
              )}

              {order?.stage === 'placing' && <Status textScale={textScale}>PLACING THE ORDER…</Status>}

              {order?.stage === 'paying' && order.order && (
                <div style={{ marginTop: px(14), borderTop: '1px dashed #1f3a30', paddingTop: px(14) }}>
                  <Row label="ORDER" value={order.order.reference} textScale={textScale} />
                  <Row label="TOTAL" value={formatMoney(order.order.total)} textScale={textScale} />
                  <div style={{ marginTop: px(10), color: '#3c8f74' }}>
                    {order.methods.length > 0 ? order.methods.join(' · ').toUpperCase() : 'PREPARING PAYMENT…'}
                  </div>
                </div>
              )}

              {order?.stage === 'placed' && order.order && (
                <div style={{ marginTop: px(16), borderTop: '1px dashed #1f3a30', paddingTop: px(14) }}>
                  <div style={{ letterSpacing: '0.16em', marginBottom: px(8) }}>ORDER PLACED</div>
                  <Row label="REFERENCE" value={order.order.reference} textScale={textScale} />
                  <Row label="STATUS" value={order.order.status.replace(/_/g, ' ').toUpperCase()} textScale={textScale} />
                  <p style={{ marginTop: px(12), marginBottom: 0, color: '#6fa9c9', lineHeight: 1.7 }}>
                    We will make you one. It will not be the one you made tonight — that one is yours.
                  </p>
                </div>
              )}

              {/* The honest blocker. It says what the *service* said, so once a
                  processor is configured this screen stops appearing on its own
                  rather than needing a client change. */}
              {(order?.stage === 'unavailable' || order?.stage === 'failed') && (
                <div
                  style={{
                    borderTop: '1px dashed #1f3a30',
                    marginTop: px(14),
                    paddingTop: px(14),
                    color: '#8fd4ff',
                  }}
                >
                  <div style={{ letterSpacing: '0.16em', marginBottom: px(8) }}>
                    {order.stage === 'unavailable' ? 'PAYMENT UNAVAILABLE' : 'ORDER NOT COMPLETED'}
                  </div>
                  <p style={{ margin: 0, lineHeight: 1.7, color: '#6fa9c9' }}>{order.reason}</p>
                  {/* In the terminal's own voice. The engineering note that
                      used to print here belongs in the README, not on a
                      readout the player is looking at. */}
                  {order.stage === 'unavailable' ? (
                    <p style={{ marginTop: px(12), marginBottom: 0, color: '#6fa9c9', lineHeight: 1.7 }}>
                      THE DEPOT CANNOT TAKE PAYMENT TONIGHT. THE ONE YOU MADE IS YOURS.
                    </p>
                  ) : (
                    <p style={{ marginTop: px(12), marginBottom: 0, color: '#3c8f74' }}>
                      Apple Pay · Google Pay · Card
                    </p>
                  )}
                </div>
              )}

              {!flow && (
                <div
                  style={{
                    borderTop: '1px dashed #1f3a30',
                    marginTop: px(14),
                    paddingTop: px(14),
                    color: '#6fa9c9',
                    lineHeight: 1.7,
                  }}
                >
                  This build has no depot to send an order to.
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: px(10), marginTop: px(18), flexWrap: 'wrap' }}>
              {order?.stage === 'address' && (
                <TerminalButton
                  onClick={() => void flow?.quote(address)}
                  textScale={textScale}
                  primary
                  disabled={!addressComplete}
                >
                  PRICE IT
                </TerminalButton>
              )}
              {order?.stage === 'quoted' && (
                <TerminalButton
                  onClick={() => void flow?.place(address, email || undefined)}
                  textScale={textScale}
                  primary
                >
                  PLACE ORDER
                </TerminalButton>
              )}
              {order?.stage === 'paying' &&
                order.methods.map((method) => (
                  <TerminalButton
                    key={method}
                    onClick={() => void flow?.pay(method)}
                    textScale={textScale}
                    primary
                  >
                    {`PAY ${formatMoney(order.order?.total ?? { currency: 'USD', amountMinor: 0 })} · ${method
                      .replace(/_/g, ' ')
                      .toUpperCase()}`}
                  </TerminalButton>
                ))}
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

function Status({ children, textScale }: { children: React.ReactNode; textScale: number }): React.ReactElement {
  return (
    <div style={{ marginTop: `${14 * textScale}px`, color: '#3c8f74', letterSpacing: '0.14em' }}>{children}</div>
  );
}

function Field({
  label,
  value,
  onChange,
  textScale,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  textScale: number;
}): React.ReactElement {
  return (
    <label style={{ display: 'flex', alignItems: 'baseline', gap: `${10 * textScale}px`, marginBottom: `${6 * textScale}px` }}>
      <span style={{ color: '#3c8f74', minWidth: `${88 * textScale}px` }}>{label}</span>
      <input
        className="sm-focus"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        style={{
          flex: 1,
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid #1f3a30',
          color: '#5affbe',
          fontFamily: FONT_STACK.mono,
          fontSize: `${12 * textScale}px`,
          padding: `${3 * textScale}px 0`,
        }}
      />
    </label>
  );
}

function TerminalButton({
  children,
  onClick,
  textScale,
  primary,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  textScale: number;
  primary?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  return (
    <button
      className="sm-focus"
      onClick={onClick}
      disabled={disabled}
      style={{
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
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
