import { describe, expect, it } from 'vitest';
import { apiBaseUrlFrom } from '../src/net/client.js';

/**
 * The build's word for where the service is, and when to take it.
 *
 * The Pages workflow bakes `VITE_API_URL=""` into a build whose `api_url`
 * input was left blank, and the first deploy asked the account's root for
 * `/v1/auth/anonymous` because `""` is not `undefined`. Blank means nobody
 * said.
 */
describe('where the service is', () => {
  const relative = '/Some-More-Cookies';

  it('asks relative to the app when nobody said', () => {
    expect(apiBaseUrlFrom({}, relative)).toBe(relative);
    expect(apiBaseUrlFrom({ VITE_API_URL: undefined }, relative)).toBe(relative);
  });

  it('treats an empty or blank value as nobody having said', () => {
    expect(apiBaseUrlFrom({ VITE_API_URL: '' }, relative)).toBe(relative);
    expect(apiBaseUrlFrom({ VITE_API_URL: '   ' }, relative)).toBe(relative);
  });

  it('takes a real answer as given, on another origin or under a prefix', () => {
    expect(apiBaseUrlFrom({ VITE_API_URL: 'https://some-more-api.fly.dev' }, relative)).toBe(
      'https://some-more-api.fly.dev',
    );
    expect(apiBaseUrlFrom({ VITE_API_URL: ' /api ' }, relative)).toBe('/api');
  });

  it('does not mistake a non-string for an answer', () => {
    expect(apiBaseUrlFrom({ VITE_API_URL: 0 }, relative)).toBe(relative);
    expect(apiBaseUrlFrom({ VITE_API_URL: null }, relative)).toBe(relative);
  });
});
