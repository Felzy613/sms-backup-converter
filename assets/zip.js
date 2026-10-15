/* Minimal ZIP reader and writer for browsers and Node.
 *
 * The reader reads the central directory (so entries written with data descriptors, as
 * Android's ZipOutputStream does, work), supports stored and deflated entries and ZIP64,
 * checks each entry's size and CRC-32, and reads entries on demand with Blob.slice (or as
 * a stream), so a large archive never has to fit in memory. The writer writes stored
 * entries the way cli/sie_to_sbr.py's ZipWriter does, byte for byte. Exposes
 * window.SieZip / module.exports. */
(function (root) {
  'use strict';

  const SIG_EOCD = 0x06054b50;
  const SIG_ZIP64_LOCATOR = 0x07064b50;
  const SIG_ZIP64_EOCD = 0x06064b50;
  const SIG_CENTRAL = 0x02014b50;
  const SIG_LOCAL = 0x04034b50;

  const CRC_TABLE = (function () {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32Update(c, bytes) {
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return c;
  }

  function crc32(bytes) {
    return (crc32Update(0xFFFFFFFF, bytes) ^ 0xFFFFFFFF) >>> 0;
  }

  // Names without the UTF-8 flag are CP437, as in Python's zipfile.
  const CP437_HIGH = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

  function cp437(bytes) {
    let s = '';
    for (const b of bytes) s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
    return s;
  }

  async function bytesOf(blob, start, end) {
    return new Uint8Array(await blob.slice(start, end).arrayBuffer());
  }

  const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  async function openZip(blob) {
    const size = blob.size;
    if (size < 22) throw new Error('This file is too small to be a ZIP archive.');
    const tailStart = Math.max(0, size - (22 + 0xFFFF));
    const tail = await bytesOf(blob, tailStart, size);
    const tv = view(tail);
    let at = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tv.getUint32(i, true) === SIG_EOCD && i + 22 + tv.getUint16(i + 20, true) <= tail.length) {
        at = i;
        break;
      }
    }
    if (at < 0) throw new Error('This is not a ZIP archive (no end-of-central-directory record).');
    const eocd = tailStart + at;
    let count = tv.getUint16(at + 10, true);
    let cdSize = tv.getUint32(at + 12, true);
    let cdOffset = tv.getUint32(at + 16, true);
    let zip64 = false;
    if (eocd >= 20) {
      const loc = await bytesOf(blob, eocd - 20, eocd);
      const lv = view(loc);
      if (lv.getUint32(0, true) === SIG_ZIP64_LOCATOR) {
        const recAt = Number(lv.getBigUint64(8, true));
        const rec = await bytesOf(blob, recAt, recAt + 56);
        const rv = view(rec);
        if (rec.length < 56 || rv.getUint32(0, true) !== SIG_ZIP64_EOCD) {
          throw new Error('This ZIP archive is damaged (bad ZIP64 end record).');
        }
        count = Number(rv.getBigUint64(32, true));
        cdSize = Number(rv.getBigUint64(40, true));
        cdOffset = Number(rv.getBigUint64(48, true));
        zip64 = true;
      }
    }
    // Bytes prepended to the archive (self-extractors) shift every offset; Python does the same.
    const shift = eocd - cdSize - cdOffset - (zip64 ? 76 : 0);
    const cd = await bytesOf(blob, cdOffset + shift, cdOffset + shift + cdSize);
    const cv = view(cd);
    const utf8 = new TextDecoder('utf-8');
    const entries = new Map();
    const names = [];
    let p = 0;
    for (let n = 0; n < count; n++) {
      if (p + 46 > cd.length || cv.getUint32(p, true) !== SIG_CENTRAL) {
        throw new Error('This ZIP archive is damaged (bad central directory).');
      }
      const flags = cv.getUint16(p + 8, true);
      const method = cv.getUint16(p + 10, true);
      const crc = cv.getUint32(p + 16, true);
      let csize = cv.getUint32(p + 20, true);
      let usize = cv.getUint32(p + 24, true);
      const nameLen = cv.getUint16(p + 28, true);
      const extraLen = cv.getUint16(p + 30, true);
      const commentLen = cv.getUint16(p + 32, true);
      let offset = cv.getUint32(p + 42, true);
      const raw = cd.subarray(p + 46, p + 46 + nameLen);
      const name = flags & 0x800 ? utf8.decode(raw) : cp437(raw);
      let e = p + 46 + nameLen;
      const end = e + extraLen;
      while (e + 4 <= end) {
        const id = cv.getUint16(e, true);
        const len = cv.getUint16(e + 2, true);
        if (id === 0x0001) {  // ZIP64 extended information
          let q = e + 4;
          if (usize === 0xFFFFFFFF) { usize = Number(cv.getBigUint64(q, true)); q += 8; }
          if (csize === 0xFFFFFFFF) { csize = Number(cv.getBigUint64(q, true)); q += 8; }
          if (offset === 0xFFFFFFFF) { offset = Number(cv.getBigUint64(q, true)); q += 8; }
        }
        e += 4 + len;
      }
      entries.set(name, { name, flags, method, crc, csize, usize, offset: offset + shift });
      names.push(name);
      p = end + commentLen;
    }

    async function dataStart(name) {
      const en = entries.get(name);
      if (!en) throw new Error('"' + name + '" is not in the ZIP archive.');
      if (en.flags & 1) throw new Error('"' + name + '" is encrypted; the archive must not have a password.');
      const head = await bytesOf(blob, en.offset, en.offset + 30);
      const hv = view(head);
      if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) {
        throw new Error('This ZIP archive is damaged ("' + name + '").');
      }
      if (en.method !== 0 && en.method !== 8) {
        throw new Error('"' + name + '" uses an unsupported compression method (' + en.method + ').');
      }
      return [en, en.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true)];
    }

    /** The entry's bytes, piece by piece; throws at the end if it is damaged. */
    async function* stream(name) {
      const [en, start] = await dataStart(name);
      let s = blob.slice(start, start + en.csize).stream();
      if (en.method === 8 && en.csize) s = s.pipeThrough(new DecompressionStream('deflate-raw'));
      const reader = s.getReader();
      let c = 0xFFFFFFFF, n = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        c = crc32Update(c, value);
        n += value.length;
        yield value;
      }
      if (n !== en.usize || ((c ^ 0xFFFFFFFF) >>> 0) !== en.crc) {
        throw new Error('"' + name + '" is damaged inside the ZIP archive (size or CRC-32 mismatch).');
      }
    }

    async function read(name) {
      const [en, start] = await dataStart(name);
      const packed = blob.slice(start, start + en.csize);
      let out;
      if (en.method === 0) {
        out = new Uint8Array(await packed.arrayBuffer());
      } else if (en.method === 8) {
        out = en.csize === 0 ? new Uint8Array(0) : new Uint8Array(await new Response(
          packed.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      }
      if (out.length !== en.usize || crc32(out) !== en.crc) {
        throw new Error('"' + name + '" is damaged inside the ZIP archive (size or CRC-32 mismatch).');
      }
      return out;
    }

    return { entries, names, read, stream };
  }

  /** Writes a ZIP archive of stored (uncompressed) entries with their sizes in the local
   *  headers and no data descriptors, which every importer accepts; ZIP64 records only when
   *  needed. sink: {write(Uint8Array)}. when: a Date (the entries' local time). */
  function zipWriter(sink, when) {
    const year = Math.min(Math.max(when.getFullYear(), 1980), 2107);
    const time = (when.getHours() << 11) | (when.getMinutes() << 5) | (when.getSeconds() >> 1);
    const date = ((year - 1980) << 9) | ((when.getMonth() + 1) << 5) | when.getDate();
    const enc = new TextEncoder();
    const list = [];
    let offset = 0;
    const MAX = 0xFFFFFFFF;
    const bytes = (n) => { const b = new Uint8Array(n); return [b, new DataView(b.buffer)]; };
    return {
      async add(name, data) {
        const nb = enc.encode(name);
        const crc = crc32(data), size = data.length, big = size >= MAX || offset >= MAX;
        const [h, v] = bytes(30 + nb.length + (big ? 20 : 0));
        v.setUint32(0, 0x04034b50, true);
        v.setUint16(4, big ? 45 : 20, true);
        v.setUint16(6, 0x0800, true);
        v.setUint16(8, 0, true);
        v.setUint16(10, time, true);
        v.setUint16(12, date, true);
        v.setUint32(14, crc, true);
        v.setUint32(18, big ? MAX : size, true);
        v.setUint32(22, big ? MAX : size, true);
        v.setUint16(26, nb.length, true);
        v.setUint16(28, big ? 20 : 0, true);
        h.set(nb, 30);
        if (big) {
          const e = 30 + nb.length;
          v.setUint16(e, 1, true);
          v.setUint16(e + 2, 16, true);
          v.setBigUint64(e + 4, BigInt(size), true);
          v.setBigUint64(e + 12, BigInt(size), true);
        }
        await sink.write(h);
        await sink.write(data);
        list.push({ nb, crc, size, offset });
        offset += h.length + size;
      },
      async close() {
        const start = offset;
        let cdSize = 0;
        for (const e of list) {
          const big = e.size >= MAX || e.offset >= MAX;
          const [h, v] = bytes(46 + e.nb.length + (big ? 28 : 0));
          v.setUint32(0, 0x02014b50, true);
          v.setUint16(4, big ? 45 : 20, true);
          v.setUint16(6, big ? 45 : 20, true);
          v.setUint16(8, 0x0800, true);
          v.setUint16(10, 0, true);
          v.setUint16(12, time, true);
          v.setUint16(14, date, true);
          v.setUint32(16, e.crc, true);
          v.setUint32(20, big ? MAX : e.size, true);
          v.setUint32(24, big ? MAX : e.size, true);
          v.setUint16(28, e.nb.length, true);
          v.setUint16(30, big ? 28 : 0, true);
          v.setUint32(42, big ? MAX : e.offset, true);
          h.set(e.nb, 46);
          if (big) {
            const x = 46 + e.nb.length;
            v.setUint16(x, 1, true);
            v.setUint16(x + 2, 24, true);
            v.setBigUint64(x + 4, BigInt(e.size), true);
            v.setBigUint64(x + 12, BigInt(e.size), true);
            v.setBigUint64(x + 20, BigInt(e.offset), true);
          }
          await sink.write(h);
          cdSize += h.length;
        }
        const n = list.length, end = start + cdSize;
        if (n >= 0xFFFF || start >= MAX || cdSize >= MAX) {
          const [z, zv] = bytes(56 + 20);
          zv.setUint32(0, 0x06064b50, true);
          zv.setBigUint64(4, 44n, true);
          zv.setUint16(12, 45, true);
          zv.setUint16(14, 45, true);
          zv.setBigUint64(24, BigInt(n), true);
          zv.setBigUint64(32, BigInt(n), true);
          zv.setBigUint64(40, BigInt(cdSize), true);
          zv.setBigUint64(48, BigInt(start), true);
          zv.setUint32(56, 0x07064b50, true);
          zv.setBigUint64(64, BigInt(end), true);
          zv.setUint32(72, 1, true);
          await sink.write(z);
        }
        const [t, tv] = bytes(22);
        const big = n >= 0xFFFF || start >= MAX || cdSize >= MAX;
        tv.setUint32(0, 0x06054b50, true);
        tv.setUint16(8, big ? 0xFFFF : n, true);
        tv.setUint16(10, big ? 0xFFFF : n, true);
        tv.setUint32(12, big ? MAX : cdSize, true);
        tv.setUint32(16, big ? MAX : start, true);
        await sink.write(t);
      },
    };
  }

  const api = { openZip, zipWriter, crc32, cp437 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SieZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
