/**
 * RFC 6455 framing, by hand.
 *
 * The service ships with no runtime dependencies (ADR-0005) and that includes
 * the WebSocket layer. This module is the whole of the bit-twiddling: reading
 * frames off a socket, writing them back, masking, and the close payload. It
 * knows nothing about sessions, marshmallows or authority — the layer above
 * turns frames into messages.
 *
 * Everything that a well-behaved peer cannot legitimately send is rejected with
 * a `WsProtocolError` carrying the close code the RFC asks for, rather than
 * being silently tolerated. A permissive WebSocket parser is a security bug.
 */

/** RFC 6455 §5.2 opcodes. */
export const OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

export type Opcode = (typeof OPCODE)[keyof typeof OPCODE];

/** Control frames may not be fragmented and may not exceed 125 bytes (§5.5). */
export const MAX_CONTROL_PAYLOAD = 125;

/** A framing violation. `closeCode` is what we send the peer before hanging up. */
export class WsProtocolError extends Error {
  readonly closeCode: number;

  constructor(closeCode: number, message: string) {
    super(message);
    this.name = 'WsProtocolError';
    this.closeCode = closeCode;
  }
}

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

export function isControlOpcode(opcode: number): boolean {
  return (opcode & 0x8) !== 0;
}

export function isKnownOpcode(opcode: number): boolean {
  return (
    opcode === OPCODE.continuation ||
    opcode === OPCODE.text ||
    opcode === OPCODE.binary ||
    opcode === OPCODE.close ||
    opcode === OPCODE.ping ||
    opcode === OPCODE.pong
  );
}

/** XOR the 4-byte masking key over the payload, in place (§5.3). */
export function applyMask(payload: Buffer, key: Buffer): Buffer {
  if (key.length !== 4) throw new WsProtocolError(1002, 'A masking key must be four bytes.');
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = (payload[i] as number) ^ (key[i & 3] as number);
  }
  return payload;
}

export interface EncodeFrameOptions {
  readonly opcode: number;
  readonly payload?: Buffer;
  readonly fin?: boolean;
  /** Clients MUST mask; servers MUST NOT (§5.1). */
  readonly mask?: boolean;
  /** Injectable so tests can assert exact bytes instead of guessing. */
  readonly maskKey?: Buffer;
  readonly randomBytes?: (size: number) => Buffer;
}

export function encodeFrame(options: EncodeFrameOptions): Buffer {
  const payload = options.payload ?? Buffer.alloc(0);
  const fin = options.fin ?? true;
  const mask = options.mask ?? false;

  if (isControlOpcode(options.opcode)) {
    if (!fin) throw new WsProtocolError(1002, 'Control frames cannot be fragmented.');
    if (payload.length > MAX_CONTROL_PAYLOAD) {
      throw new WsProtocolError(1002, 'Control frames cannot exceed 125 bytes.');
    }
  }

  const length = payload.length;
  const extended = length < 126 ? 0 : length < 65_536 ? 2 : 8;
  const header = Buffer.alloc(2 + extended + (mask ? 4 : 0));

  header[0] = (fin ? 0x80 : 0x00) | (options.opcode & 0x0f);
  const maskBit = mask ? 0x80 : 0x00;
  if (extended === 0) {
    header[1] = maskBit | length;
  } else if (extended === 2) {
    header[1] = maskBit | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = maskBit | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  if (!mask) return Buffer.concat([header, payload]);

  const key = options.maskKey ?? (options.randomBytes ?? defaultRandomBytes)(4);
  if (key.length !== 4) throw new WsProtocolError(1002, 'A masking key must be four bytes.');
  key.copy(header, 2 + extended);
  const masked = Buffer.from(payload);
  applyMask(masked, key);
  return Buffer.concat([header, masked]);
}

function defaultRandomBytes(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = Math.floor(Math.random() * 256);
  return out;
}

/** Close codes an endpoint is allowed to put on the wire (§7.4). */
export function isValidCloseCode(code: number): boolean {
  if (!Number.isInteger(code)) return false;
  if (code >= 3000 && code <= 4999) return true;
  return code === 1000 || code === 1001 || code === 1002 || code === 1003 || (code >= 1007 && code <= 1014);
}

export function encodeClosePayload(code: number, reason = ''): Buffer {
  const reasonBuffer = Buffer.from(reason, 'utf8').subarray(0, MAX_CONTROL_PAYLOAD - 2);
  const payload = Buffer.alloc(2 + reasonBuffer.length);
  payload.writeUInt16BE(code, 0);
  reasonBuffer.copy(payload, 2);
  return payload;
}

export interface CloseInfo {
  readonly code: number;
  readonly reason: string;
}

export function decodeClosePayload(payload: Buffer): CloseInfo {
  // An empty close body means "no status" (1005) — legal, and not an error.
  if (payload.length === 0) return { code: 1005, reason: '' };
  if (payload.length === 1) throw new WsProtocolError(1002, 'A close payload of one byte is malformed.');
  const code = payload.readUInt16BE(0);
  if (!isValidCloseCode(code)) throw new WsProtocolError(1002, `Close code ${code} is reserved.`);
  let reason = '';
  if (payload.length > 2) {
    try {
      reason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
    } catch {
      throw new WsProtocolError(1007, 'A close reason must be valid UTF-8.');
    }
  }
  return { code, reason };
}

/** Strict UTF-8 decode; a text frame that is not valid UTF-8 is a 1007 (§8.1). */
export function decodeUtf8(payload: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch {
    throw new WsProtocolError(1007, 'Text frames must be valid UTF-8.');
  }
}

export interface FrameReaderOptions {
  /** Servers require masked frames from clients; clients require unmasked. */
  readonly requireMask: boolean;
  readonly maxFrameBytes: number;
}

/**
 * Incremental frame parser.
 *
 * TCP hands us arbitrary slices, so this buffers and yields whole frames.
 * The buffer is bounded by `maxFrameBytes`: a peer cannot make us allocate by
 * announcing a huge length, because the length is checked before the payload is
 * waited for.
 */
export class FrameReader {
  private buffer: Buffer = Buffer.alloc(0);
  private readonly options: FrameReaderOptions;

  constructor(options: FrameReaderOptions) {
    this.options = options;
  }

  /** Bytes currently held pending a complete frame. */
  get buffered(): number {
    return this.buffer.length;
  }

  receive(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const frame = this.readOne();
      if (frame === null) return frames;
      frames.push(frame);
    }
  }

  private readOne(): Frame | null {
    const buffer = this.buffer;
    if (buffer.length < 2) return null;

    const first = buffer[0] as number;
    const second = buffer[1] as number;
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;

    // No extensions are negotiated, so any reserved bit is a protocol error.
    if (rsv !== 0) throw new WsProtocolError(1002, 'Reserved bits must be zero; no extension was negotiated.');
    if (!isKnownOpcode(opcode)) throw new WsProtocolError(1002, `Opcode 0x${opcode.toString(16)} is reserved.`);
    if (isControlOpcode(opcode)) {
      if (!fin) throw new WsProtocolError(1002, 'Control frames cannot be fragmented.');
      if (length > MAX_CONTROL_PAYLOAD) throw new WsProtocolError(1002, 'Control frames cannot exceed 125 bytes.');
    }
    if (masked !== this.options.requireMask) {
      throw new WsProtocolError(
        1002,
        this.options.requireMask ? 'Client frames must be masked.' : 'Server frames must not be masked.',
      );
    }

    if (length === 126) {
      if (buffer.length < offset + 2) return null;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (buffer.length < offset + 8) return null;
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new WsProtocolError(1009, 'Frame length is absurd.');
      length = Number(big);
      offset += 8;
    }

    // Checked before waiting for the body, so an oversized announcement costs
    // us nothing.
    if (length > this.options.maxFrameBytes) {
      throw new WsProtocolError(1009, `Frame of ${length} bytes exceeds the ${this.options.maxFrameBytes} byte limit.`);
    }

    const keyLength = masked ? 4 : 0;
    if (buffer.length < offset + keyLength + length) return null;

    let payload = buffer.subarray(offset + keyLength, offset + keyLength + length);
    if (masked) {
      const key = buffer.subarray(offset, offset + 4);
      payload = applyMask(Buffer.from(payload), Buffer.from(key));
    } else {
      payload = Buffer.from(payload);
    }

    this.buffer = buffer.subarray(offset + keyLength + length);
    return { fin, opcode, payload };
  }
}
