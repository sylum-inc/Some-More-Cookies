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
  machineSerial: () => `SM01-${pick(REFERENCE_ALPHABET, 4)}-${pick(REFERENCE_ALPHABET, 4)}`,
};
