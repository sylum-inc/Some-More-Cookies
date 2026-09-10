/**
 * The Some More terminal (spec §11).
 *
 * Commerce is subordinate to the experience. No purchase surface exists
 * before the product reveal, and the fiction is maintained through this
 * terminal until conventional checkout UI is genuinely required.
 *
 * Launch catalogue: the flagship roasted-marshmallow sandwich only.
 *
 * ## Drawn now, and drawn as a plate rather than as a page
 *
 * The medium moved into the pixel buffer with the Passport and Settings
 * (§6.2); `ui/PixelPanel.tsx` is the canvas-plus-DOM division and this file is
 * the terminal's *content*. **What it shows and when it shows it is
 * unchanged** — the same printout, the same steps, the same order of
 * questions, the same refusal in the service's own words — because the rule
 * this panel lives under is about commerce and not about pixels.
 *
 * The one thing that is a decision rather than a translation is the surface.
 * `ui/pixel/panel.ts` has carried `drawPlate` since the kit was written —
 * "a dark plate, for the one panel that is a device readout and not a page" —
 * and this is that panel: an appliance printing an order at you, not a booklet
 * you have stopped to read. So it is the one overlay in the product set on a
 * dark case rather than on paper, in the same eleven colours as everything
 * else. The green CRT it used to be (`#5affbe` on `#0d1512`) is not in the
 * palette and was never going to be: two colours nobody chose, from a table
 * with no green in it, is the exact defect `pixel/palette.ts` exists to make
 * impossible.
 *
 * ## What is not here, and will not be
 *
 * No card number, no expiry, no CVC, ever. This screen collects an address and
 * an email and hands off to a payment provider; the fields below are the
 * complete list, and a raw card field appearing in this file would be a defect
 * whatever it was for.
 *
 * ## The printer
 *
 * The readout used to arrive a line at a time on a 45ms interval. On a drawn
 * panel the still path is the only path (§12), so the printout is simply
 * *there* — and the thing the animation was standing in for, that this is an
 * appliance rather than a web page, is now carried by the plate it is printed
 * on.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { provenanceLines, type SandwichRecord } from '@somemore/sim';
import type { Address } from '@somemore/protocol';
import { TOKENS } from './styles.js';
import { OrderFlow, formatMoney, type OrderFlowState } from '../net/order.js';
import type { SyncEngine } from '../net/sync.js';
import { PixelPanel } from './PixelPanel.js';
import type { PanelBlock, PanelControl } from './pixel/index.js';

export interface TerminalProps {
  sandwich: SandwichRecord;
  onClose: () => void;
  textScale: number;
  highContrast?: boolean;
  /** The bezel's thickness, from `bezelInset`. */
  frameInset?: number;
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

/**
 * Every field this screen has, and therefore every field it can ever collect.
 *
 * A table rather than seven hand-written rows, because the list itself is the
 * claim: an address and an email, and nothing that belongs to a card. Adding a
 * field means adding a line here, which is where somebody reviewing this would
 * look for one.
 */
const FIELDS: readonly {
  readonly id: string;
  readonly label: string;
  readonly of: (address: Address, email: string) => string;
  readonly set: (value: string, address: Address) => { address?: Address; email?: string };
  readonly inputMode?: 'text' | 'email' | 'tel' | 'numeric';
}[] = [
  { id: 'name', label: 'Name', of: (a) => a.name, set: (v, a) => ({ address: { ...a, name: v } }) },
  { id: 'line1', label: 'Address', of: (a) => a.line1, set: (v, a) => ({ address: { ...a, line1: v } }) },
  { id: 'city', label: 'City', of: (a) => a.city, set: (v, a) => ({ address: { ...a, city: v } }) },
  { id: 'region', label: 'Region', of: (a) => a.region, set: (v, a) => ({ address: { ...a, region: v } }) },
  {
    id: 'postal',
    label: 'Postcode',
    of: (a) => a.postalCode,
    set: (v, a) => ({ address: { ...a, postalCode: v } }),
  },
  {
    id: 'country',
    label: 'Country',
    of: (a) => a.country,
    set: (v, a) => ({ address: { ...a, country: v.toUpperCase().slice(0, 2) } }),
  },
  { id: 'email', label: 'Email', of: (_a, email) => email, set: (v) => ({ email: v }), inputMode: 'email' },
];

export function Terminal({
  sandwich,
  onClose,
  textScale,
  highContrast,
  frameInset,
  sync,
}: TerminalProps): React.ReactElement {
  const [step, setStep] = useState<Step>('terminal');
  const [address, setAddress] = useState<Address>(emptyAddress);
  const [email, setEmail] = useState('');

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

  const page = useMemo(
    () => terminalPage(sandwich, step, order, address, email, flow !== null),
    [sandwich, step, order, address, email, flow],
  );

  return (
    <PixelPanel
      label="Some More order terminal"
      closeLabel="Close terminal"
      surface="plate"
      blocks={page.blocks}
      testIds={page.testIds}
      textScale={textScale}
      {...(highContrast === undefined ? {} : { highContrast })}
      {...(frameInset === undefined ? {} : { frameInset })}
      onClose={onClose}
      onText={(id, value) => {
        const field = FIELDS.find((entry) => entry.id === id);
        if (field === undefined) return;
        const next = field.set(value, address);
        if (next.address !== undefined) setAddress(next.address);
        if (next.email !== undefined) setEmail(next.email);
      }}
      onButton={(id) => {
        if (id === 'start') startOrder();
        else if (id === 'close' || id === 'not-now') onClose();
        else if (id === 'back') setStep('terminal');
        else if (id === 'quote') void flow?.quote(address);
        else if (id === 'place') void flow?.place(address, email || undefined);
        else if (id.startsWith('pay-')) {
          // Back to the method it came from rather than re-parsed out of the
          // id: the id is a string the layout carries, and `pay` takes one of
          // four literals. Looking it up keeps the type where it belongs.
          const method = order?.methods.find((entry) => `pay-${entry}` === id);
          if (method !== undefined) void flow?.pay(method);
        }
        else if (id.startsWith('redeem-')) void flow?.redeem(id.slice(7));
      }}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* The readout                                                                */
/* -------------------------------------------------------------------------- */

/** A label and a value in two columns, the way a receipt sets them. */
function row(label: string, value: string): string {
  return `${label.padEnd(9, ' ')}${value}`;
}

/** Whether the form has enough to price a delivery. Unchanged by the move. */
export function addressComplete(address: Address): boolean {
  return (
    address.name.trim() !== '' &&
    address.line1.trim() !== '' &&
    address.city.trim() !== '' &&
    address.postalCode.trim() !== '' &&
    address.country.trim().length === 2
  );
}

/**
 * The whole terminal, as blocks.
 *
 * Pure and exported, so the thing §11 actually cares about is checkable
 * without a browser: that the first step is a printout and not a price, that
 * no field on it belongs to a card, and that every stage the service can
 * report has something honest to say.
 */
export function terminalPage(
  sandwich: SandwichRecord,
  step: Step,
  order: OrderFlowState | null,
  address: Address,
  email: string,
  hasDepot: boolean,
): { blocks: PanelBlock[]; testIds: Record<string, string> } {
  const blocks: PanelBlock[] = [];
  const testIds: Record<string, string> = {};

  if (step === 'terminal') {
    /*
     * The printout, exactly as it was, all at once.
     *
     * One block rather than a line each: it is one thing the machine printed,
     * a screen reader should read it as one thing, and a page of twenty
     * paragraphs would put a paragraph gap between every line of a receipt.
     */
    blocks.push({
      kind: 'machine',
      id: 'printout',
      text: [
        'SOME MORE · ORDER TERMINAL',
        '',
        'ITEM SM-CLASSIC · ROASTED MARSHMALLOW ICE CREAM SANDWICH',
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
      ].join('\n'),
    });
    testIds['printout'] = 'terminal-printout';
    blocks.push({
      kind: 'controls',
      id: 'offer',
      controls: [
        // Upper case in the label rather than in a text transform: this is the
        // terminal's voice, it is what the button has always said, and it is
        // the accessible name `ritual.spec.ts` looks the button up by.
        { kind: 'button', id: 'start', label: 'MAKE THIS REAL' },
        { kind: 'button', id: 'not-now', label: 'NOT NOW' },
      ],
    });
    return { blocks, testIds };
  }

  blocks.push({ kind: 'heading', id: 'order-label', level: 2, text: 'Order' });
  blocks.push({
    kind: 'machine',
    id: 'order-lines',
    text: [
      row('ITEM', order?.product?.name ?? 'Roasted Marshmallow Ice Cream Sandwich'),
      row('QTY', '1'),
      row('MADE AT', sandwich.machine.serial),
      row('CLASS', sandwich.class),
    ].join('\n'),
  });

  if (order?.stage === 'loading') {
    blocks.push({ kind: 'machine', id: 'loading', text: 'Contacting the depot…' });
  }

  /*
   * Where to send it. A shipping form, because at this point a shipping form
   * is genuinely what is required (§11) — and nothing beyond one.
   */
  if (order?.stage === 'address' || order?.stage === 'quoting' || order?.stage === 'quoted') {
    blocks.push({ kind: 'rule', id: 'ship-rule', style: 'dashed' });
    blocks.push({ kind: 'heading', id: 'ship-label', level: 2, text: 'Where should we send it?' });
    blocks.push({
      kind: 'controls',
      id: 'ship-fields',
      controls: FIELDS.map(
        (field): PanelControl => ({
          kind: 'text',
          id: field.id,
          label: field.label,
          value: field.of(address, email),
          ...(field.inputMode === undefined ? {} : { inputMode: field.inputMode }),
        }),
      ),
    });
    for (const field of FIELDS) testIds[field.id] = `terminal-${field.id}`;
  }

  /*
   * Rewards, shown only when there are any. A terminal that advertises an
   * empty rewards section is advertising.
   */
  if (order && order.rewards.length > 0 && order.stage === 'address') {
    blocks.push({ kind: 'rule', id: 'rewards-rule', style: 'dashed' });
    blocks.push({ kind: 'heading', id: 'rewards-label', level: 2, text: 'You have' });
    for (const grant of order.rewards) {
      const used = order.redeemed.includes(grant.id);
      blocks.push({ kind: 'machine', id: `reward-${grant.id}`, text: grant.rewardCode });
      blocks.push({
        kind: 'controls',
        id: `reward-controls-${grant.id}`,
        controls: [
          {
            kind: 'button',
            id: `redeem-${grant.id}`,
            label: used ? 'APPLIED' : 'USE IT',
            disabled: used,
          },
        ],
      });
    }
  }

  // Real totals, from the service. Nothing here is computed here.
  if (order?.quote) {
    blocks.push({ kind: 'rule', id: 'quote-rule', style: 'dashed' });
    blocks.push({
      kind: 'machine',
      id: 'quote-lines',
      text: [
        row('SUBTOTAL', formatMoney(order.quote.subtotal)),
        row('SHIPPING', formatMoney(order.quote.shipping.amount)),
        row('TAX', formatMoney(order.quote.tax.total)),
        row('TOTAL', formatMoney(order.quote.total)),
      ].join('\n'),
    });
  }

  if (order?.stage === 'placing') {
    blocks.push({ kind: 'machine', id: 'placing', text: 'Placing the order…' });
  }

  if (order?.stage === 'paying' && order.order) {
    blocks.push({ kind: 'rule', id: 'paying-rule', style: 'dashed' });
    blocks.push({
      kind: 'machine',
      id: 'paying-lines',
      text: [
        row('ORDER', order.order.reference),
        row('TOTAL', formatMoney(order.order.total)),
        order.methods.length > 0 ? order.methods.join(' · ').toUpperCase() : 'PREPARING PAYMENT…',
      ].join('\n'),
    });
  }

  if (order?.stage === 'placed' && order.order) {
    blocks.push({ kind: 'rule', id: 'placed-rule', style: 'dashed' });
    blocks.push({ kind: 'heading', id: 'placed-label', level: 2, text: 'Order placed' });
    blocks.push({
      kind: 'machine',
      id: 'placed-lines',
      text: [
        row('REFERENCE', order.order.reference),
        row('STATUS', order.order.status.replace(/_/g, ' ').toUpperCase()),
      ].join('\n'),
    });
    blocks.push({
      kind: 'body',
      id: 'placed-note',
      role: 'status',
      live: 'polite',
      label: 'What happens next',
      text: 'We will make you one. It will not be the one you made tonight — that one is yours.',
    });
  }

  /*
   * The honest blocker. It says what the *service* said, so once a processor
   * is configured this screen stops appearing on its own rather than needing a
   * client change.
   */
  if (order?.stage === 'unavailable' || order?.stage === 'failed') {
    blocks.push({ kind: 'rule', id: 'blocked-rule', style: 'dashed' });
    blocks.push({
      kind: 'heading',
      id: 'blocked-label',
      level: 2,
      text: order.stage === 'unavailable' ? 'Payment unavailable' : 'Order not completed',
    });
    blocks.push({
      kind: 'body',
      id: 'blocked-reason',
      role: 'alert',
      live: 'assertive',
      label: 'What the depot said',
      text:
        order.stage === 'unavailable'
          ? // In the terminal's own voice. The engineering note that used to
            // print here belongs in the README, not on a readout the player is
            // looking at.
            `${order.reason ?? ''}\nTHE DEPOT CANNOT TAKE PAYMENT TONIGHT. THE ONE YOU MADE IS YOURS.`
          : `${order.reason ?? ''}\nApple Pay · Google Pay · Card`,
    });
  }

  if (!hasDepot) {
    blocks.push({ kind: 'rule', id: 'no-depot-rule', style: 'dashed' });
    blocks.push({
      kind: 'body',
      id: 'no-depot',
      tone: 'soft',
      text: 'This build has no depot to send an order to.',
    });
  }

  const actions: PanelControl[] = [];
  if (order?.stage === 'address') {
    actions.push({
      kind: 'button',
      id: 'quote',
      label: 'PRICE IT',
      disabled: !addressComplete(address),
    });
  }
  if (order?.stage === 'quoted') actions.push({ kind: 'button', id: 'place', label: 'PLACE ORDER' });
  if (order?.stage === 'paying') {
    for (const method of order.methods) {
      actions.push({
        kind: 'button',
        id: `pay-${method}`,
        label: `PAY ${formatMoney(order.order?.total ?? { currency: 'USD', amountMinor: 0 })} · ${method
          .replace(/_/g, ' ')
          .toUpperCase()}`,
      });
    }
  }
  actions.push({ kind: 'button', id: 'back', label: 'BACK' });
  actions.push({ kind: 'button', id: 'close', label: 'CLOSE' });
  blocks.push({ kind: 'controls', id: 'actions', controls: actions });

  return { blocks, testIds };
}

/** The colour token re-export keeps the terminal palette discoverable. */
export const TERMINAL_ACCENT = TOKENS.ice;
