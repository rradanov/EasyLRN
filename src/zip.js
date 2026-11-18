// Safe ZIP reader for the course import (T-007-fix: T008-D2, T008-D3).
//
// fflate's unzipSync() does not verify CRC-32 and decides on limits only
// while it already unpacks. Here the central directory is read first, so the
// caller can refuse an archive by the declared sizes before anything is
// inflated (zip bomb). Each entry is then inflated as a stream with a byte
// counter: an entry that produces more than it declared is stopped at once,
// and every entry is checked against its CRC-32.
import { Inflate, strFromU8 } from '../vendor/fflate.js';

/** Thrown for a broken, truncated or unsupported archive (`reason` is for logs/tests). */
export class ZipFormatError extends Error {
  constructor(reason) {
    super(`Invalid ZIP: ${reason}`);
    this.name = 'ZipFormatError';
    this.reason = reason;
  }
}

const u16 = (d, o) => d[o] | (d[o + 1] << 8);
const u32 = (d, o) => (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
const u64 = (d, o) => u32(d, o) + u32(d, o + 4) * 2 ** 32;

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CEN = 0x02014b50;
const SIG_LOC = 0x04034b50;
const MAX = 0xffffffff;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (ZIP/PNG polynomial) of bytes. */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/**
 * Read the central directory.
 * @param {Uint8Array} data the whole archive
 * @returns {{ name: string, method: number, flags: number, crc: number,
 *   compressedSize: number, size: number, offset: number, dir: boolean }[]}
 */
export function listZip(data) {
  // End of central directory: in the last 22 + 65535 bytes.
  let e = data.length - 22;
  const stop = Math.max(0, data.length - 22 - 65535);
  while (e >= stop && u32(data, e) !== SIG_EOCD) e--;
  if (e < stop) throw new ZipFormatError('no end of central directory');
  let count = u16(data, e + 10);
  let size = u32(data, e + 12);
  let offset = u32(data, e + 16);
  const zip64 = e >= 20 && u32(data, e - 20) === SIG_EOCD64_LOC;
  if (zip64) {
    const z = u64(data, e - 12);
    if (z + 56 > data.length || u32(data, z) !== SIG_EOCD64) throw new ZipFormatError('bad zip64 end record');
    count = u64(data, z + 32);
    size = u64(data, z + 40);
    offset = u64(data, z + 48);
  }
  if (offset + size > data.length) throw new ZipFormatError('central directory outside the file');

  const entries = [];
  let o = offset;
  for (let i = 0; i < count; i++) {
    if (o + 46 > data.length || u32(data, o) !== SIG_CEN) throw new ZipFormatError('bad central directory entry');
    const flags = u16(data, o + 8);
    const method = u16(data, o + 10);
    const crc = u32(data, o + 16);
    let compressedSize = u32(data, o + 20);
    let size = u32(data, o + 24);
    const nameLen = u16(data, o + 28);
    const extraLen = u16(data, o + 30);
    const commentLen = u16(data, o + 32);
    let local = u32(data, o + 42);
    const nameEnd = o + 46 + nameLen;
    if (nameEnd + extraLen + commentLen > data.length) throw new ZipFormatError('truncated central directory');
    // Like fflate: UTF-8 when the flag says so, else bytes as Latin-1.
    const name = strFromU8(data.subarray(o + 46, nameEnd), !(flags & 0x800));
    if (size === MAX || compressedSize === MAX || local === MAX) {
      // ZIP64 extended information extra field (id 1): only the fields that are 0xFFFFFFFF, in this order.
      let x = nameEnd;
      const end = nameEnd + extraLen;
      let found = false;
      while (x + 4 <= end) {
        const id = u16(data, x);
        const len = u16(data, x + 2);
        if (id === 1) {
          let p = x + 4;
          if (size === MAX) { size = u64(data, p); p += 8; }
          if (compressedSize === MAX) { compressedSize = u64(data, p); p += 8; }
          if (local === MAX) { local = u64(data, p); p += 8; }
          found = true;
          break;
        }
        x += 4 + len;
      }
      if (!found) throw new ZipFormatError('missing zip64 sizes');
    }
    entries.push({ name, method, flags, crc, compressedSize, size, offset: local, dir: name.endsWith('/') });
    o = nameEnd + extraLen + commentLen;
  }
  return entries;
}

const CHUNK = 16 * 1024; // compressed bytes per step: at most ~16 MB of output per step

/**
 * Unpack one entry from `listZip()`. Never returns more than `entry.size`
 * bytes; a mismatch in size or CRC-32 is an error.
 * @param {Uint8Array} data the whole archive
 * @param {ReturnType<typeof listZip>[number]} entry
 * @returns {Uint8Array}
 */
export function readEntry(data, entry) {
  if (entry.flags & 1) throw new ZipFormatError('encrypted entry');
  const lo = entry.offset;
  if (lo + 30 > data.length || u32(data, lo) !== SIG_LOC) throw new ZipFormatError('bad local header');
  const start = lo + 30 + u16(data, lo + 26) + u16(data, lo + 28);
  const end = start + entry.compressedSize;
  if (end > data.length) throw new ZipFormatError('truncated entry data');
  const input = data.subarray(start, end);

  let out;
  if (entry.method === 0) {
    if (entry.compressedSize !== entry.size) throw new ZipFormatError('stored size mismatch');
    out = input.slice();
  } else if (entry.method === 8) {
    out = new Uint8Array(entry.size);
    let written = 0;
    let finished = false;
    const inflate = new Inflate((chunk, final) => {
      if (written + chunk.length > entry.size) throw new ZipFormatError('entry larger than declared');
      out.set(chunk, written);
      written += chunk.length;
      if (final) finished = true;
    });
    try {
      for (let p = 0; p < input.length; p += CHUNK) {
        inflate.push(input.subarray(p, Math.min(p + CHUNK, input.length)), p + CHUNK >= input.length);
      }
      if (!input.length) inflate.push(new Uint8Array(0), true);
    } catch (err) {
      if (err instanceof ZipFormatError) throw err;
      throw new ZipFormatError(`inflate: ${err?.message || err}`);
    }
    if (!finished || written !== entry.size) throw new ZipFormatError('entry smaller than declared');
  } else {
    throw new ZipFormatError(`unsupported compression method ${entry.method}`);
  }
  if (crc32(out) !== entry.crc) throw new ZipFormatError('CRC-32 mismatch');
  return out;
}
