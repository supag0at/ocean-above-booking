import { describe, expect, it } from 'vitest';
import { BookingInvariantError, isUnavailable } from '../src/booking.ts';
import { BookingConfigError, loadBookingConfig } from '../src/config.ts';
import { makeTokenCheck } from '../src/server.ts';

const validEnv = {
  BOOKING_BIND: '172.30.3.30:8083',
  BOOKING_ALLOWED_PEERS: '172.30.3.20/32, 10.0.0.0/8',
  PG_HOST: 'db',
  PG_DATABASE: 'app',
  PG_USER: 'fb_booking',
};

describe('loadBookingConfig', () => {
  it('parses a valid env with defaults', () => {
    expect(loadBookingConfig(validEnv)).toEqual({
      bind: '172.30.3.30:8083',
      allowedPeers: ['172.30.3.20/32', '10.0.0.0/8'],
      pgHost: 'db',
      pgPort: 5432,
      pgDatabase: 'app',
      pgUser: 'fb_booking',
      logLevel: 'info',
    });
    const c = loadBookingConfig({ ...validEnv, PG_PORT: '6543', LOG_LEVEL: 'debug' });
    expect(c.pgPort).toBe(6543);
    expect(c.logLevel).toBe('debug');
  });

  it('lists every missing key', () => {
    try {
      loadBookingConfig({});
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BookingConfigError);
      const issues = (e as BookingConfigError).issues.join('\n');
      for (const k of ['BOOKING_BIND', 'BOOKING_ALLOWED_PEERS', 'PG_HOST', 'PG_DATABASE', 'PG_USER'])
        expect(issues).toContain(k);
    }
  });

  it('rejects a wildcard bind', () => {
    expect(() => loadBookingConfig({ ...validEnv, BOOKING_BIND: '0.0.0.0:8083' })).toThrow(BookingConfigError);
    expect(() => loadBookingConfig({ ...validEnv, BOOKING_BIND: '0.0.0.0:8083' })).toThrow(/BOOKING_BIND/);
  });

  it('rejects a bad CIDR and bad port', () => {
    expect(() => loadBookingConfig({ ...validEnv, BOOKING_ALLOWED_PEERS: '172.30.3.20/99' })).toThrow(
      /BOOKING_ALLOWED_PEERS/,
    );
    expect(() => loadBookingConfig({ ...validEnv, PG_PORT: '70000' })).toThrow(/PG_PORT/);
  });

  it('never echoes provided values in the error', () => {
    try {
      loadBookingConfig({ ...validEnv, BOOKING_ALLOWED_PEERS: 'sekrit-value', BOOKING_BIND: 'sekrit-value' });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BookingConfigError);
      expect((e as Error).message).not.toContain('sekrit-value');
      expect((e as BookingConfigError).issues.join(' ')).not.toContain('sekrit-value');
    }
  });
});

describe('makeTokenCheck', () => {
  const check = makeTokenCheck('s3cret-token');
  it('accepts Bearer in any case', () => {
    expect(check('Bearer s3cret-token')).toBe(true);
    expect(check('bearer s3cret-token')).toBe(true);
  });
  it('rejects everything else', () => {
    expect(check(undefined)).toBe(false);
    expect(check(['Bearer s3cret-token'])).toBe(false);
    expect(check('Bearer wrong')).toBe(false);
    expect(check('Bearer s3cret-toke')).toBe(false);
    expect(check('Bearer s3cret-token-x')).toBe(false);
    expect(check('Bearer  s3cret-token')).toBe(false);
    expect(check('Basic s3cret-token')).toBe(false);
    expect(check('s3cret-token')).toBe(false);
    expect(check('Bearer ')).toBe(false);
  });
  it('throws on an empty token', () => {
    expect(() => makeTokenCheck('')).toThrow();
  });
});

describe('isUnavailable', () => {
  it.each(['ECONNREFUSED', '57P01', '08006', '53300', '57014', '40001'])('true for code %s', (code) => {
    expect(isUnavailable({ code })).toBe(true);
  });
  it('true for a pool connect timeout', () => {
    expect(isUnavailable(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });
  it.each(['23505', '42501'])('false for code %s', (code) => {
    expect(isUnavailable({ code })).toBe(false);
  });
  it('false for invariant errors and plain errors', () => {
    expect(isUnavailable(new BookingInvariantError('x'))).toBe(false);
    expect(isUnavailable(new Error('boom'))).toBe(false);
  });
});
