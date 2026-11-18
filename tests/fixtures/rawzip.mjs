// T-008 (tester): a tiny hand-written ZIP writer for hostile and unusual
// archives that fflate's zipSync() will not produce: names with `..`, names
// without the UTF-8 flag (old Windows "Compressed folder"), wrong CRC, sizes
// in the header that lie, unknown compression methods, duplicate names.
// Entries are STORED (method 0) unless `method`/`data` say otherwise.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(u8) {
  let c = 0xffffffff;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {{ name: string|Uint8Array, data?: Uint8Array, utf8?: boolean, crc?: number,
 *           method?: number, size?: number, csize?: number }[]} entries
 *   `name` as a string is written as UTF-8 (flag bit 11 set unless utf8 === false);
 *   as bytes it is written as is (flag not set) — e.g. CP866 bytes.
 *   `crc`, `size` (uncompressed) and `csize` override the real values (to lie).
 * @returns {Buffer}
 */
export function rawZip(entries) {
  const enc = new TextEncoder();
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const nameBytes = typeof e.name === 'string' ? enc.encode(e.name) : e.name;
    const utf8 = typeof e.name === 'string' && e.utf8 !== false && /[^\x00-\x7f]/.test(e.name);
    const data = e.data ?? new Uint8Array(0);
    const method = e.method ?? 0;
    const crc = e.crc ?? crc32(e.raw ?? data);
    const csize = e.csize ?? data.length;
    const size = e.size ?? (e.raw ? e.raw.length : data.length);
    const flag = utf8 ? 0x0800 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(flag, 6);
    lh.writeUInt16LE(method, 8); lh.writeUInt32LE(0x5b210000, 10);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(csize, 18); lh.writeUInt32LE(size, 22);
    lh.writeUInt16LE(nameBytes.length, 26); lh.writeUInt16LE(0, 28);
    const local = Buffer.concat([lh, Buffer.from(nameBytes), Buffer.from(data)]);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flag, 8); ch.writeUInt16LE(method, 10); ch.writeUInt32LE(0x5b210000, 12);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(csize, 20); ch.writeUInt32LE(size, 24);
    ch.writeUInt16LE(nameBytes.length, 28); ch.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([ch, Buffer.from(nameBytes)]));
    locals.push(local);
    offset += local.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** The smallest valid ZIP: no entries, only the end-of-central-directory record. */
export const EMPTY_ZIP = rawZip([]);

/** Encode a Cyrillic string in CP866 (DOS/old Windows ZIPs in Bulgarian locale). */
export function cp866(s) {
  return Uint8Array.from([...s], (ch) => {
    const c = ch.codePointAt(0);
    if (c < 0x80) return c;
    if (c >= 0x410 && c <= 0x43f) return c - 0x410 + 0x80;
    if (c >= 0x440 && c <= 0x44f) return c - 0x440 + 0xe0;
    return 0x3f; // '?'
  });
}
