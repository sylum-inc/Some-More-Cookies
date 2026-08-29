import {
  SCHEMA_VERSION,
  type AssemblyQuality,
  type MachineRun,
  type RoastTelemetrySummary,
  type SM01,
  type TaxQuote,
  type ShippingQuote,
  type Address,
} from '../src/index.js';

export const NOW = '2026-08-29T12:00:00.000Z';
export const LATER = '2026-08-29T13:00:00.000Z';

export const goodRoast: RoastTelemetrySummary = {
  durationMs: 92_000,
  averageDistanceCm: 21.5,
  minimumDistanceCm: 12,
  rotations: 14.5,
  evenness: 0.93,
  peakSurfaceTempC: 172,
  charFraction: 0.06,
  meltFraction: 0.82,
  ignited: false,
  flareUps: 0,
  blownOut: false,
  dropped: false,
  grade: 'golden',
  simVersion: '0.4.1',
};

export const goodAssembly: AssemblyQuality = {
  alignment: 0.95,
  chocolateCoverage: 0.9,
  grahamIntegrity: 1,
  squish: 0.4,
  heatTransfer: 0.88,
  layerOrderCorrect: true,
  assembledInSeconds: 11.2,
  defects: [],
  score: 0.93,
};

export const goodRun: MachineRun = {
  runId: 'run_01',
  machineSerial: 'SM01-1999K-12345-B',
  program: 'classic',
  startedAt: NOW,
  completedAt: LATER,
  chillSeconds: 42,
  pressForceN: 310,
  churnRpm: 120,
  coreTempC: -6.5,
  outcome: 'success',
  anomalies: [],
  quirkCodesApplied: [],
  wearDelta: { drum: 0.001, press: 0.002, chiller: 0.0015, dispenser: 0.0005, hopper: 0.0004, belt: 0.0009 },
  firmwareVersion: '2.1.0',
};

export const machine: SM01 = {
  model: 'SM-01',
  serialNumber: 'SM01-1999K-12345-B',
  firmwareVersion: '2.1.0',
  installedAt: NOW,
  wear: { drum: 0, press: 0, chiller: 0, dispenser: 0, hopper: 0, belt: 0 },
  cyclesRun: 0,
  jamsCleared: 0,
  lastRunAt: null,
  lastServicedAt: null,
  maintenanceHistory: [],
  quirks: [],
  finishCode: 'factory_enamel',
  operational: true,
};

export const address: Address = {
  name: 'Rowan Ash',
  line1: '18 Kindling Lane',
  line2: null,
  city: 'Bend',
  region: 'OR',
  postalCode: '97701',
  country: 'US',
  phone: null,
};

export const taxQuote: TaxQuote = {
  provider: 'internal_flat',
  providerQuoteId: null,
  calculatedAt: NOW,
  expiresAt: LATER,
  taxableSubtotal: { currency: 'USD', amountMinor: 3200 },
  lines: [{ name: 'State', jurisdiction: 'US-OR', rate: 0, amount: { currency: 'USD', amountMinor: 0 } }],
  total: { currency: 'USD', amountMinor: 0 },
  exclusive: true,
};

export const shippingQuote: ShippingQuote = {
  provider: 'internal_flat',
  providerQuoteId: null,
  carrier: 'ColdRun',
  service: 'two_day_frozen',
  amount: { currency: 'USD', amountMinor: 1200 },
  estimatedDeliveryDays: { min: 2, max: 3 },
  requiresColdChain: true,
  calculatedAt: NOW,
  expiresAt: LATER,
};

export const SCHEMA = SCHEMA_VERSION;
