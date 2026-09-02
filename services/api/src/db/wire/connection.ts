import net from 'node:net';
import tls from 'node:tls';
import { MessageReader, MessageWriter, StreamParser } from './buffer.js';
import { decodeValue, encodeParameter, type SqlParameter } from './codec.js';
import { PgConnectionError, PgError } from './errors.js';
import { createScramSession, md5Password, type ScramSession } from './scram.js';

/** Protocol version 3.0, the only one PostgreSQL 7.4+ has ever spoken. */
const PROTOCOL_VERSION = 196608;
const SSL_REQUEST_CODE = 80877103;

export interface ConnectionOptions {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string | null;
  readonly database: string;
  /** `disable` | `prefer` | `require`. `verify-full` is not implemented. */
  readonly ssl: 'disable' | 'prefer' | 'require';
  readonly applicationName: string;
  readonly connectTimeoutMs: number;
  readonly statementTimeoutMs: number;
  readonly searchPath: string | null;
  readonly onNotice?: (notice: PgError) => void;
}

export interface QueryResult<Row = Record<string, unknown>> {
  readonly rows: Row[];
  readonly fields: readonly FieldDescription[];
  /** Rows affected, from `CommandComplete` (`INSERT 0 3` -> 3). */
  readonly rowCount: number;
  readonly command: string;
}

export interface FieldDescription {
  readonly name: string;
  readonly dataTypeOid: number;
}

type Pending = {
  resolve: (results: QueryResult[]) => void;
  reject: (error: unknown) => void;
  results: QueryResult[];
  fields: FieldDescription[];
  rows: Record<string, unknown>[];
  failure: unknown;
};

/**
 * One PostgreSQL connection: a socket, the v3 handshake, and both query
 * protocols.
 *
 * A connection processes exactly one query at a time — the pool is what gives
 * you concurrency. That keeps the state machine here small enough to read,
 * which matters a great deal for something hand-rolled.
 */
export class PgConnection {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private readonly parser = new StreamParser();
  private pending: Pending | null = null;
  private handshake: { resolve: () => void; reject: (error: unknown) => void } | null = null;
  private scram: ScramSession | null = null;
  private closedReason: Error | null = null;
  private ready = false;
  /** Server parameters (`server_version`, `integer_datetimes`, …). */
  readonly parameters = new Map<string, string>();
  private backendPid = 0;
  private backendSecret = 0;
  /** Set while the connection sits inside an explicit BEGIN. */
  inTransaction = false;
  /** Advanced every time the connection is handed out; identifies leaks. */
  readonly id: string;

  private readonly options: ConnectionOptions;

  constructor(options: ConnectionOptions, id: string) {
    this.options = options;
    this.id = id;
  }

  get isUsable(): boolean {
    return this.socket !== null && this.ready && this.closedReason === null;
  }

  async connect(): Promise<void> {
    const socket = await this.openSocket();
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('error', (error: Error) => this.fail(new PgConnectionError(error.message, { cause: error })));
    socket.on('close', () => this.fail(new PgConnectionError('postgres: connection closed by peer')));

    await new Promise<void>((resolve, reject) => {
      this.handshake = { resolve, reject };
      const startup = new MessageWriter()
        .int32(PROTOCOL_VERSION)
        .cstring('user')
        .cstring(this.options.user)
        .cstring('database')
        .cstring(this.options.database)
        .cstring('application_name')
        .cstring(this.options.applicationName)
        .cstring('client_encoding')
        .cstring('UTF8')
        .cstring('DateStyle')
        .cstring('ISO, MDY')
        .byte(0)
        .frame(null);
      socket.write(startup);
    });

    this.ready = true;
    if (this.options.statementTimeoutMs > 0) {
      await this.simple(`SET statement_timeout = ${Math.floor(this.options.statementTimeoutMs)}`);
    }
    if (this.options.searchPath !== null) {
      await this.simple(`SET search_path = ${this.options.searchPath}`);
    }
  }

  private openSocket(): Promise<net.Socket | tls.TLSSocket> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        raw.destroy();
        reject(new PgConnectionError(`postgres: connection to ${this.options.host}:${this.options.port} timed out`));
      }, this.options.connectTimeoutMs);
      timer.unref?.();

      const settle = (value: net.Socket | tls.TLSSocket): void => {
        clearTimeout(timer);
        value.setNoDelay(true);
        resolve(value);
      };
      const bail = (error: Error): void => {
        clearTimeout(timer);
        reject(new PgConnectionError(`postgres: ${error.message}`, { cause: error }));
      };

      const raw = this.options.host.startsWith('/')
        ? net.createConnection({ path: `${this.options.host}/.s.PGSQL.${this.options.port}` })
        : net.createConnection({ host: this.options.host, port: this.options.port });
      raw.once('error', bail);

      raw.once('connect', () => {
        if (this.options.ssl === 'disable' || this.options.host.startsWith('/')) {
          raw.removeListener('error', bail);
          settle(raw);
          return;
        }
        // SSLRequest is a bare int32 packet answered with a single byte.
        raw.write(new MessageWriter().int32(SSL_REQUEST_CODE).frame(null));
        raw.once('data', (answer: Buffer) => {
          const supported = answer.length > 0 && answer[0] === 0x53; // 'S'
          if (!supported) {
            if (this.options.ssl === 'require') {
              bail(new Error('server refused TLS but sslmode=require'));
              return;
            }
            raw.removeListener('error', bail);
            settle(raw);
            return;
          }
          const secure = tls.connect({ socket: raw, rejectUnauthorized: false });
          secure.once('error', bail);
          secure.once('secureConnect', () => {
            raw.removeListener('error', bail);
            secure.removeListener('error', bail);
            settle(secure);
          });
        });
      });
    });
  }

  private write(buffer: Buffer): void {
    const socket = this.socket;
    if (socket === null) throw this.closedReason ?? new PgConnectionError('postgres: connection is closed');
    socket.write(buffer);
  }

  private fail(error: Error): void {
    if (this.closedReason !== null) return;
    this.closedReason = error;
    this.ready = false;
    const handshake = this.handshake;
    this.handshake = null;
    if (handshake !== null) handshake.reject(error);
    const pending = this.pending;
    this.pending = null;
    if (pending !== null) pending.reject(error);
    this.socket?.destroy();
    this.socket = null;
  }

  end(): void {
    if (this.socket !== null && this.closedReason === null) {
      try {
        this.socket.write(new MessageWriter().frame('X'));
      } catch {
        /* the socket is already gone; nothing to say goodbye to */
      }
    }
    this.closedReason ??= new PgConnectionError('postgres: connection closed by the client');
    this.ready = false;
    this.socket?.destroy();
    this.socket = null;
  }

  private onData(chunk: Buffer): void {
    this.parser.push(chunk);
    for (;;) {
      let message: { type: string; body: Buffer } | null;
      try {
        message = this.parser.next();
      } catch (error) {
        this.fail(error instanceof Error ? error : new PgConnectionError(String(error)));
        return;
      }
      if (message === null) return;
      try {
        this.dispatch(message.type, message.body);
      } catch (error) {
        this.fail(error instanceof Error ? error : new PgConnectionError(String(error)));
        return;
      }
    }
  }

  private dispatch(type: string, body: Buffer): void {
    const reader = new MessageReader(body);
    switch (type) {
      case 'R':
        void this.onAuthentication(reader);
        return;
      case 'S': {
        this.parameters.set(reader.cstring(), reader.cstring());
        return;
      }
      case 'K':
        this.backendPid = reader.int32();
        this.backendSecret = reader.int32();
        return;
      case 'Z': {
        const status = String.fromCharCode(reader.byte());
        this.inTransaction = status !== 'I';
        const handshake = this.handshake;
        if (handshake !== null) {
          this.handshake = null;
          handshake.resolve();
          return;
        }
        this.settle();
        return;
      }
      case 'T': {
        const pending = this.requirePending();
        const count = reader.int16();
        pending.fields = [];
        for (let i = 0; i < count; i += 1) {
          const name = reader.cstring();
          reader.int32(); // table oid
          reader.int16(); // column attribute number
          const dataTypeOid = reader.int32();
          reader.int16(); // type size
          reader.int32(); // type modifier
          reader.int16(); // format code
          pending.fields.push({ name, dataTypeOid });
        }
        pending.rows = [];
        return;
      }
      case 'D': {
        const pending = this.requirePending();
        const count = reader.int16();
        const row: Record<string, unknown> = {};
        for (let i = 0; i < count; i += 1) {
          const length = reader.int32();
          const field = pending.fields[i];
          const name = field?.name ?? `column${i}`;
          if (length === -1) {
            row[name] = null;
            continue;
          }
          const raw = reader.slice(length).toString('utf8');
          row[name] = field === undefined ? raw : decodeValue(field.dataTypeOid, raw);
        }
        pending.rows.push(row);
        return;
      }
      case 'C': {
        const pending = this.requirePending();
        const tag = reader.cstring();
        pending.results.push({
          rows: pending.rows,
          fields: pending.fields,
          rowCount: parseRowCount(tag),
          command: tag.split(' ')[0] ?? tag,
        });
        pending.rows = [];
        pending.fields = [];
        return;
      }
      case 'I': {
        const pending = this.requirePending();
        pending.results.push({ rows: [], fields: [], rowCount: 0, command: 'EMPTY' });
        return;
      }
      case 'E': {
        const error = new PgError(readFields(reader));
        const pending = this.pending;
        if (pending !== null) {
          pending.failure = error;
          return;
        }
        const handshake = this.handshake;
        if (handshake !== null) {
          this.handshake = null;
          handshake.reject(error);
          this.socket?.destroy();
          this.socket = null;
          this.closedReason = error;
        }
        return;
      }
      case 'N': {
        this.options.onNotice?.(new PgError(readFields(reader)));
        return;
      }
      // ParseComplete, BindComplete, CloseComplete, NoData, ParameterDescription,
      // PortalSuspended, NotificationResponse: nothing to accumulate.
      case '1':
      case '2':
      case '3':
      case 'n':
      case 't':
      case 's':
      case 'A':
      case 'G':
      case 'H':
      case 'W':
      case 'c':
      case 'd':
        return;
      default:
        return;
    }
  }

  private async onAuthentication(reader: MessageReader): Promise<void> {
    const code = reader.int32();
    try {
      switch (code) {
        case 0:
          /*
           * AuthenticationOk. Mutual authentication is the whole point of
           * SCRAM: `finish()` checks the server's signature and is the only
           * thing that proves the peer knows the password verifier. A server
           * that starts SASL and then declares success without sending
           * SASLFinal has proved nothing, and accepting that would hand a
           * man-in-the-middle a session — and, with a salt and an iteration
           * count of its own choosing, an offline crack of the client proof
           * it just collected.
           */
          if (this.scram !== null) {
            throw new PgConnectionError(
              'postgres: server declared authentication complete without finishing SCRAM — refusing to trust it',
            );
          }
          return;
        case 3: // cleartext
          this.write(new MessageWriter().cstring(this.requirePassword()).frame('p'));
          return;
        case 5: {
          // md5
          const salt = reader.slice(4);
          const digest = md5Password(this.options.user, this.requirePassword(), salt);
          this.write(new MessageWriter().cstring(digest).frame('p'));
          return;
        }
        case 10: {
          // SASL
          const mechanisms: string[] = [];
          for (;;) {
            const name = reader.cstring();
            if (name.length === 0) break;
            mechanisms.push(name);
          }
          if (!mechanisms.includes('SCRAM-SHA-256')) {
            throw new PgConnectionError(
              `postgres: server offered only [${mechanisms.join(', ')}]; this client speaks SCRAM-SHA-256`,
            );
          }
          const session = createScramSession(this.requirePassword());
          this.scram = session;
          const initial = Buffer.from(session.clientFirst, 'utf8');
          this.write(
            new MessageWriter().cstring('SCRAM-SHA-256').int32(initial.length).bytes(initial).frame('p'),
          );
          return;
        }
        case 11: {
          // SASLContinue
          const session = this.scram;
          if (session === null) throw new PgConnectionError('postgres: unexpected SASLContinue');
          const final = await session.continue(reader.rest().toString('utf8'));
          this.write(new MessageWriter().bytes(Buffer.from(final, 'utf8')).frame('p'));
          return;
        }
        case 12: {
          // SASLFinal
          const session = this.scram;
          if (session === null) throw new PgConnectionError('postgres: unexpected SASLFinal');
          session.finish(reader.rest().toString('utf8'));
          this.scram = null;
          return;
        }
        default:
          throw new PgConnectionError(
            `postgres: authentication method ${code} is not supported by this client ` +
              '(supported: trust, cleartext, md5, SCRAM-SHA-256)',
          );
      }
    } catch (error) {
      this.fail(error instanceof Error ? error : new PgConnectionError(String(error)));
    }
  }

  private requirePassword(): string {
    const password = this.options.password;
    if (password === null) {
      throw new PgConnectionError('postgres: the server asked for a password but none was configured');
    }
    return password;
  }

  private requirePending(): Pending {
    const pending = this.pending;
    if (pending === null) throw new PgConnectionError('postgres: backend sent data with no query in flight');
    return pending;
  }

  private settle(): void {
    const pending = this.pending;
    if (pending === null) return;
    this.pending = null;
    if (pending.failure !== undefined) pending.reject(pending.failure);
    else pending.resolve(pending.results);
  }

  private run(send: () => void): Promise<QueryResult[]> {
    if (!this.isUsable) {
      return Promise.reject(this.closedReason ?? new PgConnectionError('postgres: connection is not ready'));
    }
    if (this.pending !== null) {
      return Promise.reject(new Error('postgres: a query is already in flight on this connection'));
    }
    return new Promise<QueryResult[]>((resolve, reject) => {
      this.pending = { resolve, reject, results: [], fields: [], rows: [], failure: undefined };
      try {
        send();
      } catch (error) {
        this.pending = null;
        reject(error);
      }
    });
  }

  /**
   * Simple query protocol. Accepts multiple statements separated by `;`, which
   * is exactly what a migration file is, and runs them in one implicit
   * transaction unless the text manages its own.
   */
  async simple(sql: string): Promise<QueryResult[]> {
    return this.run(() => this.write(new MessageWriter(sql.length + 32).cstring(sql).frame('Q')));
  }

  /**
   * Extended query protocol: Parse / Bind / Describe / Execute / Sync with real
   * parameter binding. Values never touch the SQL text, so there is nothing to
   * escape and nothing to inject.
   */
  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlParameter[] = [],
  ): Promise<QueryResult<Row>> {
    const results = await this.run(() => {
      const parse = new MessageWriter(sql.length + 32)
        .cstring('') // unnamed prepared statement
        .cstring(sql)
        .int16(0) // let the server infer parameter types
        .frame('P');

      const bind = new MessageWriter(128)
        .cstring('') // unnamed portal
        .cstring('') // unnamed statement
        .int16(0) // all parameters in text format
        .int16(params.length);
      for (const param of params) {
        const encoded = encodeParameter(param);
        if (encoded === null) {
          bind.int32(-1);
        } else {
          const bytes = Buffer.from(encoded, 'utf8');
          bind.int32(bytes.length).bytes(bytes);
        }
      }
      bind.int16(0); // all results in text format

      const describe = new MessageWriter(8).byte(0x50).cstring('').frame('D'); // 'P' = portal
      const execute = new MessageWriter(16).cstring('').int32(0).frame('E');
      const sync = new MessageWriter(0).frame('S');

      this.write(Buffer.concat([parse, bind.frame('B'), describe, execute, sync]));
    });

    const first = results[0];
    if (first === undefined) return { rows: [], fields: [], rowCount: 0, command: 'NONE' };
    return first as QueryResult<Row>;
  }

  /** For diagnostics only — never logged with credentials attached. */
  describe(): { pid: number; serverVersion: string } {
    return { pid: this.backendPid, serverVersion: this.parameters.get('server_version') ?? 'unknown' };
  }

  /** Opens a second connection purely to cancel the in-flight query. */
  cancelInFlight(): void {
    if (this.backendPid === 0 || this.options.host.startsWith('/')) return;
    const socket = net.createConnection({ host: this.options.host, port: this.options.port });
    socket.on('error', () => socket.destroy());
    socket.on('connect', () => {
      socket.write(new MessageWriter().int32(80877102).int32(this.backendPid).int32(this.backendSecret).frame(null));
      socket.end();
    });
  }
}

function readFields(reader: MessageReader): Map<string, string> {
  const fields = new Map<string, string>();
  for (;;) {
    const code = reader.byte();
    if (code === 0) break;
    fields.set(String.fromCharCode(code), reader.cstring());
  }
  return fields;
}

/** `INSERT 0 3` / `UPDATE 2` / `SELECT 7` -> the trailing count. */
function parseRowCount(tag: string): number {
  const parts = tag.split(' ');
  const last = parts[parts.length - 1];
  if (last === undefined) return 0;
  const parsed = Number.parseInt(last, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}
