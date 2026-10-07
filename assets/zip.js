/* Minimal read-only ZIP reader for browsers and Node.
 *
 * Reads the central directory (so entries written with data descriptors, as Android's
 * ZipOutputStream does, work), supports stored and deflated entries and ZIP64, checks
 * each entry's size and CRC-32, and reads entries on demand with Blob.slice, so a large
 * archive never has to fit in memory. Exposes window.SieZip / module.exports. */
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

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
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

    async function read(name) {
      const en = entries.get(name);
      if (!en) throw new Error('"' + name + '" is not in the ZIP archive.');
      if (en.flags & 1) throw new Error('"' + name + '" is encrypted; the archive must not have a password.');
      const head = await bytesOf(blob, en.offset, en.offset + 30);
      const hv = view(head);
      if (head.length < 30 || hv.getUint32(0, true) !== SIG_LOCAL) {
        throw new Error('This ZIP archive is damaged ("' + name + '").');
      }
      const start = en.offset + 30 + hv.getUint16(26, true) + hv.getUint16(28, true);
      const packed = blob.slice(start, start + en.csize);
      let out;
      if (en.method === 0) {
        out = new Uint8Array(await packed.arrayBuffer());
      } else if (en.method === 8) {
        out = en.csize === 0 ? new Uint8Array(0) : new Uint8Array(await new Response(
          packed.stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      } else {
        throw new Error('"' + name + '" uses an unsupported compression method (' + en.method + ').');
      }
      if (out.length !== en.usize || crc32(out) !== en.crc) {
        throw new Error('"' + name + '" is damaged inside the ZIP archive (size or CRC-32 mismatch).');
      }
      return out;
    }

    return { entries, names, read };
  }

  const api = { openZip, crc32, cp437 };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SieZip = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
