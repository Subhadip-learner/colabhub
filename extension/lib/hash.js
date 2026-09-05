// lib/hash.js — hashing + encoding helpers.
// Uses Web Crypto only, so it runs unchanged in the Chrome MV3 service worker and in Node ≥ 20 (tests).

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8Encode(str) {
  return enc.encode(str);
}

export function utf8Decode(bytes) {
  return dec.decode(bytes);
}

export function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(bytes) {
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

/**
 * Git blob SHA-1:  sha1("blob <byteLength>\0" + content)
 * This is exactly the `sha` GitHub reports for a file in the Contents API, so we can
 * tell whether the remote already has this exact content without downloading it.
 */
export async function gitBlobSha(bytes) {
  const header = enc.encode(`blob ${bytes.byteLength}\0`);
  const buf = new Uint8Array(header.byteLength + bytes.byteLength);
  buf.set(header, 0);
  buf.set(bytes, header.byteLength);
  return toHex(await crypto.subtle.digest('SHA-1', buf));
}

export function bytesToBase64(bytes) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

export function base64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
