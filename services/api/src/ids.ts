import { randomBytes, randomUUID } from 'node:crypto';

/** Prefixes make ids self-describing in logs and in the database. */
export const ID_PREFIX = {
  account: 'acct',
  identity: 'idn',
  passport: 'pas',
  campsite: 'cmp',
  invite: 'inv',
  session: 'ses',
  trace: 'trc',
  landmark: 'lmk',
  sandwich: 'swh',
  photo: 'pho',
  note: 'not',
  stamp: 'stp',
  patch: 'pat',
  ticket: 'tkt',
  discovery: 'dsc',
  maintenance: 'mnt',
  run: 'run',
  reward: 'rwd',
  grant: 'grt',
  claim: 'clm',
  product: 'prd',
  variant: 'var',
  cart: 'crt',
  cartItem: 'cit',
  order: 'ord',
  orderLine: 'lin',
  refund: 'ref',
  promotion: 'pro',
  report: 'rep',
  request: 'req',
  magicLink: 'mlt',
  event: 'evt',
  contentDocument: 'cdoc',
  contentRelease: 'crel',
  codeBatch: 'bat',
  codeRedemption: 'crd',
} as const;

export type IdPrefix = (typeof ID_PREFIX)[keyof typeof ID_PREFIX];

export interface IdFactory {
  next(prefix: IdPrefix): string;
  token(bytes?: number): string;
  campCode(): string;
  orderReference(): string;
  machineSerial(): string;
}

const CAMP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
/** Ambiguous glyphs (I, O, Q, U, Y) are left out of stamped serials. */
const SERIAL_LETTERS = 'ABCDEFGHJKLMNPRSTVWXZ';

const REFERENCE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

function pick(alphabet: string, length: number): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = bytes[i] ?? 0;
    out += alphabet[byte % alphabet.length] ?? alphabet[0];
  }
  return out;
}

export const idFactory: IdFactory = {
  next: (prefix) => `${prefix}_${randomUUID().replace(/-/g, '')}`,
  token: (bytes = 24) => randomBytes(bytes).toString('base64url'),
  campCode: () => pick(CAMP_CODE_ALPHABET, 6),
  orderReference: () => `SM-${pick(REFERENCE_ALPHABET, 6)}`,
  /**
   * A unit serial in the machine's canonical format: build year, batch
   * letter, five-digit unit number, check character (spec §3.3). This is the
   * same shape the simulation stamps on the decal, so a serial can travel
   * from the world to the service and back without translation.
   */
  machineSerial: () => {
    const year = 1997 + Math.floor(Math.random() * 7);
    const batch = pick(SERIAL_LETTERS, 1);
    const unit = String(Math.floor(10000 + Math.random() * 90000));
    const check = pick(SERIAL_LETTERS, 1);
    return `SM01-${year}${batch}-${unit}-${check}`;
  },
};
