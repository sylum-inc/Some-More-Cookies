import { describe, expect, it } from 'vitest';
import {
  checksumOf,
  createScramSession,
  decodeValue,
  encodeParameter,
  loadMigrations,
  md5Password,
  parseDatabaseUrl,
  parseTextArray,
} from '../src/db/index.js';
import { MessageReader, MessageWriter, StreamParser } from '../src/db/wire/buffer.js';

/*
 * The wire client, tested without a server. Everything below is the part of the
 * PostgreSQL protocol that is pure arithmetic — framing, encoding, SCRAM — and
 * that is exactly the part where a hand-rolled driver is most likely to be
 * subtly wrong for months.
 */

describe('protocol framing', () => {
  it('frames a typed message with a length that includes itself', () => {
    const framed = new MessageWriter().cstring('SELECT 1').frame('Q');
    expect(String.fromCharCode(framed[0] ?? 0)).toBe('Q');
    expect(framed.readInt32BE(1)).toBe(framed.length - 1);
    expect(framed.subarray(5, framed.length - 1).toString()).toBe('SELECT 1');
    expect(framed[framed.length - 1]).toBe(0);
  });

  it('frames the untyped startup packet with no type byte', () => {
    const startup = new MessageWriter().int32(196608).cstring('user').cstring('rowan').byte(0).frame(null);
    expect(startup.readInt32BE(0)).toBe(startup.length);
    expect(startup.readInt32BE(4)).toBe(196608);
  });

  it('reads back everything it wrote', () => {
    const written = new MessageWriter().int16(-3).int32(70_000).cstring('café').bytes(Buffer.from([1, 2])).frame('X');
    const reader = new MessageReader(written.subarray(5));
    expect(reader.int16()).toBe(-3);
    expect(reader.int32()).toBe(70_000);
    expect(reader.cstring()).toBe('café');
    expect([...reader.rest()]).toEqual([1, 2]);
  });

  it('splits a stream into messages regardless of how the TCP chunks land', () => {
    const stream = Buffer.concat([
      new MessageWriter().cstring('one').frame('C'),
      new MessageWriter().cstring('two').frame('C'),
    ]);

    const parser = new StreamParser();
    const seen: string[] = [];
    // One byte at a time: the pathological chunking a real socket can produce.
    for (const byte of stream) {
      parser.push(Buffer.from([byte]));
      for (;;) {
        const message = parser.next();
        if (message === null) break;
        seen.push(new MessageReader(message.body).cstring());
      }
    }
    expect(seen).toEqual(['one', 'two']);
  });

  it('holds back a partial message rather than guessing', () => {
    const parser = new StreamParser();
    parser.push(new MessageWriter().cstring('whole').frame('C').subarray(0, 4));
    expect(parser.next()).toBeNull();
  });
});

describe('parameter encoding', () => {
  it('encodes each type the repositories actually bind', () => {
    expect(encodeParameter('plain')).toBe('plain');
    expect(encodeParameter(42)).toBe('42');
    expect(encodeParameter(0.94)).toBe('0.94');
    expect(encodeParameter(true)).toBe('t');
    expect(encodeParameter(false)).toBe('f');
    expect(encodeParameter(null)).toBeNull();
    expect(encodeParameter(undefined)).toBeNull();
    expect(encodeParameter(new Date('2026-08-29T12:00:00.000Z'))).toBe('2026-08-29T12:00:00.000Z');
    expect(encodeParameter({ a: [1, 'two'] })).toBe('{"a":[1,"two"]}');
    expect(encodeParameter(Buffer.from([0xde, 0xad]))).toBe('\\xdead');
  });

  it('quotes array elements so a comma cannot become a separator', () => {
    expect(encodeParameter(['a', 'b,c', 'say "hi"'])).toBe('{"a","b,c","say \\"hi\\""}');
    expect(parseTextArray('{"a","b,c","say \\"hi\\""}')).toEqual(['a', 'b,c', 'say "hi"']);
    expect(parseTextArray('{}')).toEqual([]);
  });

  it('decodes results by column type', () => {
    expect(decodeValue(16, 't')).toBe(true);
    expect(decodeValue(23, '17')).toBe(17);
    expect(decodeValue(701, '0.5')).toBe(0.5);
    expect(decodeValue(3802, '{"ok":true}')).toEqual({ ok: true });
    // int8 beyond 2^53 stays a string rather than quietly losing precision.
    expect(decodeValue(20, '9007199254740993')).toBe('9007199254740993');
    expect(decodeValue(25, 'as-is')).toBe('as-is');
  });
});

describe('SCRAM-SHA-256', () => {
  it('produces a client-first-message with a fresh nonce and no channel binding', () => {
    const a = createScramSession('hunter2').clientFirst;
    const b = createScramSession('hunter2').clientFirst;
    expect(a.startsWith('n,,n=,r=')).toBe(true);
    expect(a).not.toBe(b);
  });

  it('refuses a server that will not prove it knows the password', async () => {
    const session = createScramSession('hunter2');
    const nonce = session.clientFirst.slice('n,,n=,r='.length);
    const serverFirst = `r=${nonce}serverpart,s=${Buffer.from('salty!!!').toString('base64')},i=4096`;
    const final = await session.continue(serverFirst);
    expect(final).toMatch(/^c=biws,r=/);
    expect(final).toContain(',p=');
    expect(() => session.finish('v=bm90LWEtcmVhbC1zaWduYXR1cmU=')).toThrow(/server signature mismatch/);
  });

  it('rejects a server nonce that does not extend the client nonce', async () => {
    const session = createScramSession('hunter2');
    await expect(session.continue('r=somethingelse,s=c2FsdA==,i=4096')).rejects.toThrow(/does not extend/);
  });

  it('rejects an absurd iteration count instead of burning the CPU', async () => {
    const session = createScramSession('hunter2');
    const nonce = session.clientFirst.slice('n,,n=,r='.length);
    await expect(session.continue(`r=${nonce}x,s=c2FsdA==,i=999999999`)).rejects.toThrow(/iteration count/);
  });

  it('computes the documented md5 digest', () => {
    // md5(md5(password + user) + salt), the shape libpq sends.
    expect(md5Password('rowan', 'hunter2', Buffer.from([1, 2, 3, 4]))).toMatch(/^md5[0-9a-f]{32}$/);
  });
});

describe('connection strings', () => {
  it('parses the shape a platform hands you', () => {
    const config = parseDatabaseUrl('postgres://user:p%40ss@db.internal:6543/somemore?sslmode=require&pool_max=25');
    expect(config).toMatchObject({
      host: 'db.internal',
      port: 6543,
      user: 'user',
      password: 'p@ss',
      database: 'somemore',
      ssl: 'require',
      maxConnections: 25,
    });
  });

  it('defaults sensibly and understands a unix socket directory', () => {
    const config = parseDatabaseUrl('postgresql:///somemore?host=/var/run/postgresql');
    expect(config.host).toBe('/var/run/postgresql');
    expect(config.port).toBe(5432);
    expect(config.ssl).toBe('prefer');
    expect(config.searchPath).toBe('somemore, public');
  });

  it('refuses a URL that is not Postgres at all', () => {
    expect(() => parseDatabaseUrl('mysql://localhost/somemore')).toThrow(/postgres/);
    expect(() => parseDatabaseUrl('not a url')).toThrow(/valid URL/);
  });
});

describe('the migration set on disk', () => {
  it('is ordered, uniquely numbered and correctly named', async () => {
    const migrations = await loadMigrations();
    expect(migrations.length).toBeGreaterThan(0);
    const versions = migrations.map((m) => m.version);
    expect(versions).toEqual([...versions].sort((a, b) => a - b));
    expect(new Set(versions).size).toBe(versions.length);
    for (const migration of migrations) {
      expect(migration.filename).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
      expect(migration.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it('checksums content, not line endings', () => {
    expect(checksumOf('CREATE TABLE t ();\n')).toBe(checksumOf('CREATE TABLE t ();\r\n'));
    expect(checksumOf('a')).not.toBe(checksumOf('b'));
  });
});
