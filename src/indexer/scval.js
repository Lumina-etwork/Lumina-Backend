import { xdr, nativeToScVal, StrKey, scValToNative } from '@stellar/stellar-sdk';

/**
 * ScVal <-> JS codec for Lumina Soroban contract events.
 *
 * Soroban contract events carry their event name as an ScSymbol in topic[0],
 * the event's primary key in topic[1], and the payload struct flattened into a
 * single ScVec in `value`. Fields declared as `BytesN<32>` (our SHA-256 asset
 * fingerprint) serialize as `scvBytes`, whose XDR form is a 4-byte little-endian
 * length prefix followed by the raw octets -- `nativeToScVal(buffer)` produces
 * exactly that, so no special-casing is required.
 *
 * NOTE: `xdr.ScVal` in stellar-sdk v17 exposes no `switch()` method and no
 * `ScSymbol`/`ScU64` constructors. Discriminate on the `type` string property
 * instead, and build values through `nativeToScVal` / the `ScVal.scvXxx`
 * factories.
 */

const { ScVal } = xdr;

export const EVENT_IP_ANCHOR = 'ip_anchor';
export const EVENT_ESCROW_NEW = 'escrow_new';
export const EVENT_PAY_REL = 'pay_rel';

/* ------------------------------- encoding -------------------------------- */

export const encodeSymbol = (sym) => nativeToScVal(sym, { type: 'symbol' }).toXDR('base64');

export const encodeAddress = (addr) =>
  nativeToScVal(addr, { type: 'address' }).toXDR('base64');

export const encodeU64 = (n) => nativeToScVal(BigInt(n), { type: 'u64' }).toXDR('base64');

export const encodeU32 = (n) => nativeToScVal(Number(n), { type: 'u32' }).toXDR('base64');

export const encodeI128 = (n) =>
  nativeToScVal(BigInt(n), { type: 'i128' }).toXDR('base64');

/** SHA-256 fingerprint -> scvBytes (BytesN<32> on the wire). */
export const encodeBytes = (buf) => nativeToScVal(buf).toXDR('base64');

/**
 * Event payload struct -> scvVec, matching what soroban-sdk emits.
 * `hints` is an optional per-element type-hint array; omit an entry to infer.
 */
export function encodeVec(values, hints = []) {
  const elements = values.map((v, i) => nativeToScVal(v, hints[i] ? { type: hints[i] } : undefined));
  return ScVal.scvVec(elements).toXDR('base64');
}

/* ------------------------------- decoding -------------------------------- */

export function fromXDR(b64) {
  return xdr.ScVal.fromXDR(b64, 'base64');
}

/**
 * Accept whatever representation the caller has: the raw JSON-RPC transport
 * yields base64 strings, whereas `rpc.Server.getEvents()` has already decoded
 * topics/value into xdr.ScVal instances.
 */
export function asScVal(input) {
  if (input === null || input === undefined) return input;
  if (xdr.ScVal.is(input)) return input;
  if (typeof input === 'string') return xdr.ScVal.fromXDR(input, 'base64');
  if (input instanceof Uint8Array) return xdr.ScVal.fromXDR(input);
  return input;
}

/**
 * The SDK's ScVal arms (`sym`, `vec`, `bytes`, `i128` ...) are data properties,
 * not methods, and integer arms yield bigint / Int128Parts while `bytes` yields
 * a plain Uint8Array. `scValToNative` already normalises all of that, so lean on
 * it and only deep-convert Uint8Array leaves into Buffers for SQLite/BLOB use.
 */
function normalize(native) {
  if (native instanceof Uint8Array && !Buffer.isBuffer(native)) return Buffer.from(native);
  if (Array.isArray(native)) return native.map(normalize);
  return native;
}

/** Convert a decoded ScVal into a plain JS value. */
export function toNative(scval) {
  return normalize(scValToNative(asScVal(scval)));
}

export const decodeTopic = (value) => toNative(value);

export function decodeTopics(topics = []) {
  return topics.map(decodeTopic);
}

/** Event `value` is always an scvVec in practice; tolerate a bare scalar too. */
export function decodeEventData(value) {
  const native = toNative(value);
  return Array.isArray(native) ? native : [native];
}

export const eventName = (topics = []) => {
  const first = decodeTopic(topics[0]);
  return typeof first === 'string' ? first : null;
};

export function isValidAddress(value) {
  if (typeof value !== 'string') return false;
  try {
    return StrKey.isValidEd25519PublicKey(value);
  } catch {
    return false;
  }
}
