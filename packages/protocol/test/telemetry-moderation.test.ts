import { describe, expect, it } from 'vitest';
import {
  AnalyticsEventSchema,
  BlockSchema,
  CreateBlockRequestSchema,
  CreateReportRequestSchema,
  EventBatchSchema,
  ModerationReportSchema,
  REPORT_TRANSITIONS,
  ReportTargetSchema,
  canTransitionReport,
} from '../src/index.js';
import { NOW } from './fixtures.js';

const event = {
  id: 'evt_1',
  name: 'sandwich_saved',
  occurredAt: NOW,
  platform: 'ios',
  appVersion: '0.3.0',
  schemaVersion: '1.0.0',
};

describe('telemetry', () => {
  it('accepts a known event with defaulted nulls', () => {
    const parsed = AnalyticsEventSchema.parse(event);
    expect(parsed.accountId).toBeNull();
    expect(parsed.props).toEqual({});
  });

  it('rejects unknown event names and non-JSON props', () => {
    expect(AnalyticsEventSchema.safeParse({ ...event, name: 'user_rage_quit' }).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ ...event, props: { fn: () => 1 } }).success).toBe(false);
    expect(AnalyticsEventSchema.safeParse({ ...event, props: { nested: { ok: [1, 'two', null] } } }).success).toBe(
      true,
    );
  });

  it('bounds the batch size', () => {
    expect(EventBatchSchema.safeParse({ events: [] }).success).toBe(false);
    expect(EventBatchSchema.safeParse({ events: Array.from({ length: 101 }, () => event) }).success).toBe(false);
    expect(EventBatchSchema.safeParse({ events: [event] }).success).toBe(true);
  });
});

describe('moderation', () => {
  it('discriminates report targets', () => {
    expect(ReportTargetSchema.safeParse({ kind: 'account', accountId: 'acct_2' }).success).toBe(true);
    expect(ReportTargetSchema.safeParse({ kind: 'photo', photoId: 'pho_2' }).success).toBe(true);
    expect(ReportTargetSchema.safeParse({ kind: 'account', photoId: 'pho_2' }).success).toBe(false);
    expect(ReportTargetSchema.safeParse({ kind: 'planet' }).success).toBe(false);
  });

  it('defaults a new report to open and standard priority', () => {
    const report = ModerationReportSchema.parse({
      id: 'rep_1',
      reporterAccountId: 'acct_1',
      target: { kind: 'account', accountId: 'acct_2' },
      reason: 'harassment',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(report.state).toBe('open');
    expect(report.priority).toBe('standard');
  });

  it('enforces the report state machine', () => {
    expect(canTransitionReport('open', 'reviewing')).toBe(true);
    expect(canTransitionReport('actioned', 'open')).toBe(false);
    expect(canTransitionReport('dismissed', 'reviewing')).toBe(true);
    expect(REPORT_TRANSITIONS.actioned).toEqual([]);
  });

  it('requires idempotency keys for reports and blocks', () => {
    expect(
      CreateReportRequestSchema.safeParse({ target: { kind: 'account', accountId: 'a' }, reason: 'spam' }).success,
    ).toBe(false);
    expect(CreateBlockRequestSchema.safeParse({ blockedAccountId: 'acct_2' }).success).toBe(false);
    expect(
      CreateBlockRequestSchema.safeParse({ idempotencyKey: 'block-0001', blockedAccountId: 'acct_2' }).success,
    ).toBe(true);
    expect(
      BlockSchema.safeParse({ blockerAccountId: 'acct_1', blockedAccountId: 'acct_2', createdAt: NOW }).success,
    ).toBe(true);
  });

  it('rejects an unknown report reason', () => {
    expect(
      CreateReportRequestSchema.safeParse({
        idempotencyKey: 'report-0001',
        target: { kind: 'account', accountId: 'a' },
        reason: 'annoying',
      }).success,
    ).toBe(false);
  });
});
