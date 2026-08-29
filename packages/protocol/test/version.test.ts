import { describe, expect, it } from 'vitest';
import {
  API_VERSION,
  MIN_SUPPORTED_SCHEMA_MAJOR,
  SCHEMA_MAJOR,
  SCHEMA_VERSION,
  checkSchemaCompatibility,
} from '../src/index.js';

describe('schema version constants', () => {
  it('exposes a semver schema version and a matching major', () => {
    expect(SCHEMA_VERSION).toBe('1.0.0');
    expect(SCHEMA_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(SCHEMA_MAJOR).toBe(Number(SCHEMA_VERSION.split('.')[0]));
    expect(API_VERSION).toBe('v1');
    expect(MIN_SUPPORTED_SCHEMA_MAJOR).toBeLessThanOrEqual(SCHEMA_MAJOR);
  });

  it('accepts compatible client versions', () => {
    expect(checkSchemaCompatibility('1.0.0')).toEqual({ compatible: true });
    expect(checkSchemaCompatibility('1.7.3')).toEqual({ compatible: true });
  });

  it('rejects unparseable, too-old and too-new versions', () => {
    expect(checkSchemaCompatibility('banana')).toEqual({ compatible: false, reason: 'unparseable' });
    expect(checkSchemaCompatibility('0.9.0')).toEqual({ compatible: false, reason: 'too_old' });
    expect(checkSchemaCompatibility('2.0.0')).toEqual({ compatible: false, reason: 'too_new' });
  });
});
