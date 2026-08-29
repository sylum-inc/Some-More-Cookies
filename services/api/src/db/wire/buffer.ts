/**
 * Byte plumbing for the PostgreSQL v3 frontend/backend protocol.
 *
 * Deliberately tiny and allocation-aware: the wire client is the one place in
 * this service that speaks bytes, so it keeps its own reader/writer rather than
 * pulling in a driver (ADR-0005: zero runtime dependencies).
 */

/** Grow-on-demand writer for a single frontend message. */
export class MessageWriter {
  private buffer: Buffer;
  private offset = 0;

  constructor(initialSize = 256) {
    this.buffer = Buffer.allocUnsafe(initialSize);
  }

  private ensure(extra: number): void {
    if (this.offset + extra <= this.buffer.length) return;
    let size = this.buffer.length * 2;
    while (size < this.offset + extra) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buffer.copy(next, 0, 0, this.offset);
    this.buffer = next;
  }

  byte(value: number): this {
    this.ensure(1);
    this.buffer[this.offset] = value & 0xff;
    this.offset += 1;
    return this;
  }

  int16(value: number): this {
    this.ensure(2);
    this.buffer.writeInt16BE(value, this.offset);
    this.offset += 2;
    return this;
  }

  int32(value: number): this {
    this.ensure(4);
    this.buffer.writeInt32BE(value, this.offset);
    this.offset += 4;
    return this;
  }

  /** A C string: UTF-8 bytes followed by a NUL terminator. */
  cstring(value: string): this {
    const bytes = Buffer.byteLength(value, 'utf8');
    this.ensure(bytes + 1);
    this.buffer.write(value, this.offset, 'utf8');
    this.offset += bytes;
    this.buffer[this.offset] = 0;
    this.offset += 1;
    return this;
  }

  bytes(value: Buffer): this {
    this.ensure(value.length);
    value.copy(this.buffer, this.offset);
    this.offset += value.length;
    return this;
  }

  /**
   * Frame the accumulated payload as a protocol message. `type` is the message
   * type byte, or `null` for the untyped startup/SSL packets.
   */
  frame(type: string | null): Buffer {
    const payload = this.buffer.subarray(0, this.offset);
    const header = type === null ? 4 : 5;
    const out = Buffer.allocUnsafe(header + payload.length);
    let at = 0;
    if (type !== null) {
      out[0] = type.charCodeAt(0);
      at = 1;
    }
    out.writeInt32BE(payload.length + 4, at);
    payload.copy(out, at + 4);
    return out;
  }
}

/** Cursor over one backend message body. */
export class MessageReader {
  private offset = 0;

  private readonly buffer: Buffer;

  constructor(buffer: Buffer) {
    this.buffer = buffer;
  }

  get remaining(): number {
    return this.buffer.length - this.offset;
  }

  byte(): number {
    const value = this.buffer[this.offset];
    this.offset += 1;
    return value ?? 0;
  }

  int16(): number {
    const value = this.buffer.readInt16BE(this.offset);
    this.offset += 2;
    return value;
  }

  int32(): number {
    const value = this.buffer.readInt32BE(this.offset);
    this.offset += 4;
    return value;
  }

  cstring(): string {
    const end = this.buffer.indexOf(0, this.offset);
    const stop = end === -1 ? this.buffer.length : end;
    const value = this.buffer.toString('utf8', this.offset, stop);
    this.offset = stop + 1;
    return value;
  }

  slice(length: number): Buffer {
    const value = this.buffer.subarray(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }

  rest(): Buffer {
    const value = this.buffer.subarray(this.offset);
    this.offset = this.buffer.length;
    return value;
  }
}

/**
 * Splits a TCP byte stream into backend messages. Every backend message after
 * the handshake is `type byte | int32 length (inclusive of itself) | payload`.
 */
export class StreamParser {
  private pending: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
  }

  /** Pull the next complete message, or `null` if more bytes are needed. */
  next(): { type: string; body: Buffer } | null {
    if (this.pending.length < 5) return null;
    const length = this.pending.readInt32BE(1);
    if (length < 4) throw new Error(`postgres: nonsensical message length ${length}`);
    const total = length + 1;
    if (this.pending.length < total) return null;
    const type = String.fromCharCode(this.pending[0] ?? 0);
    const body = this.pending.subarray(5, total);
    this.pending = this.pending.subarray(total);
    return { type, body };
  }
}
