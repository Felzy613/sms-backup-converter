/* Message backup converter: the conversion engine.
 *
 * Reads Fig / TAK (SMS Import / Export), SMS Backup & Restore, Wonder, Pom and Buggy
 * Backup backups and writes SMS Backup & Restore XML, Fig / TAK ZIPs or Wonder ZIPs.
 * A line-for-line port of cli/sie_to_sbr.py: the same decisions and byte-identical files
 * (tests/test_all.py checks this). Runs as a classic <script> in browsers
 * (window.SieToSbr) and under Node (module.exports). It never uses the network. */
(function (root) {
  'use strict';

  const VERSION = '1.0.0';
  const APP = 'sms-ie-to-sbr';
  const INSERT_TOKEN = 'insert-address-token';  // Android's placeholder for the phone's own number
  const UNKNOWN_SUB_ID = '-1';                  // SubscriptionManager.INVALID_SUBSCRIPTION_ID

  // Keys added by SMS Import / Export (v2 prefixes them with "__", v1 did not).
  const K_PARTS = ['__parts', 'parts'];
  const K_SENDER = ['__sender_address', 'sender_address'];
  const K_RECIPS = ['__recipient_addresses', 'recipient_addresses'];
  const K_NAME = ['__display_name', 'display_name'];

  // Characters XML 1.0 cannot contain at all, not even as &#..; references.
  const ILLEGAL = '[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\uFFFE\\uFFFF\\uD800-\\uDFFF]';
  const XML_ILLEGAL = new RegExp(ILLEGAL, 'u');
  const XML_ILLEGAL_ALL = new RegExp(ILLEGAL, 'gu');
  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
    '\n': '&#10;', '\r': '&#13;', '\t': '&#9;' };
  const ESCAPE_RE = /[&<>"\n\r\t]/g;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // Attributes in the order SMS Backup & Restore writes them; see cli/sie_to_sbr.py.
  const SMS_ORDER = ['protocol', 'address', 'date', 'type', 'subject', 'body', 'toa', 'sc_toa',
    'service_center', 'read', 'status', 'locked', 'date_sent', 'sub_id', 'readable_date',
    'contact_name'];
  const SMS_OMIT = new Set(['protocol', 'locked', 'date_sent']);
  const MMS_ORDER = ['date', 'rr', 'sub', 'ct_t', 'read_status', 'seen', 'msg_box', 'address',
    'sub_cs', 'resp_st', 'retr_st', 'd_tm', 'text_only', 'exp', 'locked', 'm_id', 'st',
    'retr_txt_cs', 'retr_txt', 'date_sent', 'read', 'm_size', 'rpt_a', 'ct_cls', 'pri', 'sub_id',
    'tr_id', 'resp_txt', 'ct_l', 'm_cls', 'd_rpt', 'v', 'm_type', 'readable_date', 'contact_name'];
  const MMS_OMIT = new Set(['text_only']);
  const COMPUTED = new Set(['date', 'address', 'sub_id', 'readable_date', 'contact_name']);
  const MMS_COPIED = MMS_ORDER.filter((k) => !COMPUTED.has(k));
  const PART_ATTRS = ['seq', 'ct', 'name', 'chset', 'cd', 'fn', 'cid', 'cl', 'ctt_s', 'ctt_t', 'text'];
  const ADDR_ATTRS = ['address', 'type', 'charset'];
  const SMS_TYPES = { 1: 'received', 2: 'sent', 3: 'draft', 4: 'outbox', 5: 'failed', 6: 'queued' };
  const MMS_BOXES = { 1: 'received', 2: 'sent', 3: 'draft', 4: 'outbox' };

  const TARGETS = ['sbr', 'fig', 'wonder'];
  const TARGET_NAMES = { sbr: 'SMS Backup & Restore XML', fig: 'Fig / TAK (SMS Import / Export ZIP)', wonder: 'Wonder ZIP' };
  const APP_PARTS = '/data/user_de/0/com.android.providers.telephony/app_parts/';  // where Android keeps MMS files
  // Buggy Backup stores each SMS as JSON with one-letter keys; these are the Android columns.
  const BUGGY_KEYS = [['q', 'address'], ['r', 'body'], ['m', 'date'], ['n', 'date_sent'], ['h', 'type'], ['b', 'read'],
    ['k', 'protocol'], ['g', 'status'], ['d', 'locked'], ['l', 'sub_id'], ['o', 'creator'], ['e', 'seen']];
  // File name extensions for attachments written to a Wonder ZIP.
  const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/bmp': 'bmp', 'image/webp': 'webp', 'audio/amr': 'amr', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a',
    'video/mp4': 'mp4', 'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/x-vcard': 'vcf', 'text/vcard': 'vcf' };
  const DESCRIBE = {
    sie: 'Fig / TAK: SMS Import / Export (com.github.tmo1.sms_ie) export: messages.ndjson + data/',
    sbr: 'SMS Backup & Restore XML backup (attachments inside, as base64)',
    wonder: 'Wonder ZIP backup: an XML file + mms_attachments/',
    pom: 'Pom ZIP backup: sms.xml + mms.xml (attachments inside, as base64)',
    buggy: 'Buggy Backup ZIP: conversations/conv_N (SMS only)',
  };

  // ----------------------------------------------------------------------- helpers

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const isDict = (o) => o !== null && typeof o === 'object' && !Array.isArray(o);

  function pick(o, keys) {
    if (!isDict(o)) return null;
    for (const k of keys) if (hasOwn(o, k) && o[k] !== null) return o[k];
    return null;
  }

  /** A column value as a string, or null when the source has no value. */
  function sval(o, key) {
    if (!isDict(o) || !hasOwn(o, key)) return null;
    const v = o[key];
    if (v === null || typeof v === 'object') return null;
    if (typeof v === 'boolean') return v ? '1' : '0';
    return typeof v === 'string' ? v : String(v);
  }

  const isInt = (s) => typeof s === 'string' && /^-?[0-9]+$/.test(s);

  function mmsParts(o) {
    const p = pick(o, K_PARTS);
    return Array.isArray(p) ? p.filter(isDict) : [];
  }

  const ROWS = new WeakMap();
  /** The MMS's address rows (From/To/Cc/Bcc) in their original order in the phone's table. */
  function mmsAddrRows(o) {
    if (ROWS.has(o)) return ROWS.get(o);
    let rows = [];
    const s = pick(o, K_SENDER);
    if (isDict(s)) rows.push(s);
    const r = pick(o, K_RECIPS);
    if (Array.isArray(r)) rows = rows.concat(r.filter(isDict));
    if (rows.length && rows.every((x) => isInt(sval(x, '_id')))) {
      rows.sort((a, b) => cmpBig(BigInt(sval(a, '_id')), BigInt(sval(b, '_id'))));
    }
    ROWS.set(o, rows);
    return rows;
  }

  function partFile(p) {
    const d = sval(p, '_data');
    return d ? d.replace(/\\/g, '/').split('/').pop() : null;
  }

  const digits = (s) => (s || '').replace(/[^0-9]/g, '');

  /** Loose identity of an address, close to Android's PHONE_NUMBERS_EQUAL matching. */
  function addrKey(a) {
    a = (a || '').trim();
    const tokens = a.split(/\s+/).filter(Boolean);
    if (tokens.length > 1 && tokens.every((t) => digits(t).length >= 7)) {
      return 'multi:' + Array.from(new Set(tokens.map(addrKey))).sort().join(',');
    }
    const d = digits(a);
    if (d.length >= 7 && !/[A-Za-z@]/.test(a)) return d.slice(-10);
    return a.toLowerCase();
  }

  function mask(a) {
    const d = digits(a);
    if ((a || '').startsWith('multi:')) return '[' + a.split(',').length + ' numbers]';
    return d.length >= 7 ? '…' + d.slice(-4) : a;
  }

  const esc = (s) => s.replace(ESCAPE_RE, (c) => ESCAPES[c]);
  const cmpBig = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  const floorDiv1000 = (ms) => (ms >= 0n ? ms / 1000n : -((-ms + 999n) / 1000n));
  const pad = (n, w = 2) => String(n).padStart(w, '0');

  function cmpList(a, b) {  // Python-style comparison of tuples/lists
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const x = a[i], y = b[i];
      const c = Array.isArray(x) ? cmpList(x, y) : x < y ? -1 : x > y ? 1 : 0;
      if (c) return c;
    }
    return a.length - b.length;
  }

  const FORMATTERS = new Map();
  function parts(date, tz) {
    const key = tz || '';
    if (!FORMATTERS.has(key)) {
      FORMATTERS.set(key, new Intl.DateTimeFormat('en-US', { timeZone: tz || undefined,
        hourCycle: 'h23', era: 'short', year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', minute: 'numeric', second: 'numeric' }));
    }
    const out = {};
    for (const p of FORMATTERS.get(key).formatToParts(date)) out[p.type] = p.value;
    return out;
  }

  /** The date the way SMS Backup & Restore shows it, e.g. 'Sep 30, 2010 8:34:28 AM'. */
  function readable(ms, tz) {
    const secs = Number(floorDiv1000(ms));
    if (!Number.isSafeInteger(secs) || Math.abs(secs) > 8.64e12) return null;
    const p = parts(new Date(secs * 1000), tz);
    const year = Number(p.year), hour = Number(p.hour);
    if (p.era !== 'AD' || year < 1 || year > 9999) return null;
    return MONTHS[Number(p.month) - 1] + ' ' + Number(p.day) + ', ' + year + ' ' + (hour % 12 || 12) +
      ':' + p.minute.padStart(2, '0') + ':' + p.second.padStart(2, '0') + ' ' + (hour < 12 ? 'AM' : 'PM');
  }

  function utc(ms, withSeconds = true) {
    const secs = Number(floorDiv1000(ms));
    const d = new Date(secs * 1000);
    const y = d.getUTCFullYear();
    if (!Number.isFinite(y) || y < 1 || y > 9999) return '';
    const day = pad(y, 4) + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    const time = pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes());
    return withSeconds ? day + ' ' + time + ':' + pad(d.getUTCSeconds()) : day + ' ' + time + ' UTC';
  }

  function checkTimeZone(tz) {
    if (!tz) return null;
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return null;
    } catch (e) {
      return 'Unknown time zone "' + tz + '" - use a name like America/New_York or Europe/London.';
    }
  }

  const localTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function subIdFor(o, policy) {
    if (policy === 'keep') return sval(o, 'sub_id');
    if (policy === 'unknown') return UNKNOWN_SUB_ID;
    return policy;
  }

  const clean = (s, mode) => (s ? s.replace(XML_ILLEGAL_ALL, mode === 'strip' ? '' : '�') : s);

  const isPdf = (p) => (sval(p, 'ct') || '').split(';')[0].trim().toLowerCase() === 'application/pdf';

  /** The MMS parts that are written: all of them, or all but PDF files with noPdf. */
  function writtenParts(o, options) {
    const parts = mmsParts(o);
    return options.noPdf ? parts.filter((p) => !isPdf(p)) : parts;
  }

  /** The UTF-8 size of a text; an unpaired surrogate counts as 3 bytes. */
  function u8len(s) {
    if (!s) return 0;
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xD800 && c <= 0xDBFF && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xFC00) === 0xDC00) {
        n += 4;
        i++;
      } else n += 3;
    }
    return n;
  }

  function base64(bytes) {
    if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    }
    let s = '';
    for (let i = 0; i < bytes.length; i += 32766) {  // a multiple of 3: no padding mid-way
      s += btoa(String.fromCharCode.apply(null, bytes.subarray(i, i + 32766)));
    }
    return s;
  }

  function unbase64(s) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(s);
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(s, 'base64'));
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function uuid4() {
    const b = new Uint8Array(16);
    root.crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  /** Local time as YYYYMMDDHHMMSS, the stamp SMS Backup & Restore puts in file names. */
  function fileStamp(d) {
    return pad(d.getFullYear(), 4) + pad(d.getMonth() + 1) + pad(d.getDate()) +
      pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function localStamp(d) {
    const off = -d.getTimezoneOffset();
    return pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + ' ' +
      (off < 0 ? '-' : '+') + pad(Math.floor(Math.abs(off) / 60)) + pad(Math.abs(off) % 60);
  }

  // ----------------------------------------------------------------------- source

  /** One source record: its line number in messages.ndjson, 'sms' or 'mms', the JSON object. */
  class Msg {
    constructor(line, kind, o) {
      this.line = line;
      this.kind = kind;
      this.o = o;
      this._ms = undefined;
    }

    get dateMs() {  // a BigInt, or null
      if (this._ms === undefined) {
        const d = sval(this.o, 'date');
        if (!isInt(d)) {
          this._ms = null;
        } else {
          let v = BigInt(d);
          if (this.kind === 'mms' && v < 100000000000n) v *= 1000n;  // MMS dates are in seconds
          this._ms = v;
        }
      }
      return this._ms;
    }

    get direction() {
      if (this.kind === 'sms') {
        const t = sval(this.o, 'type');
        return hasOwn(SMS_TYPES, t) ? SMS_TYPES[t] : 'type ' + (t === null ? 'None' : t);
      }
      const b = sval(this.o, 'msg_box');
      return hasOwn(MMS_BOXES, b) ? MMS_BOXES[b] : 'msg_box ' + (b === null ? 'None' : b);
    }
  }

  const BLANK = new Set([0x20, 0x09, 0x0A, 0x0D, 0x0B, 0x0C]);

  /** 'sms', 'mms', or null for a record that is neither. */
  function classify(o) {
    if (!isDict(o)) return null;
    if (pick(o, K_PARTS) !== null || hasOwn(o, 'msg_box') || hasOwn(o, 'm_type')) return 'mms';
    if (hasOwn(o, 'body') || hasOwn(o, 'address')) return 'sms';
    return null;
  }

  function parseNdjson(bytes) {
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const msgs = [], bad = [];
    let blank = 0, line = 0, start = 0;
    while (start < bytes.length) {
      let end = bytes.indexOf(0x0A, start);
      end = end < 0 ? bytes.length : end + 1;
      line += 1;
      const raw = bytes.subarray(start, end);
      start = end;
      if (raw.every((b) => BLANK.has(b))) {
        blank += 1;
        continue;
      }
      let o;
      try {
        o = JSON.parse(decoder.decode(raw));
      } catch (e) {
        bad.push([line, 'unreadable line: ' + e.message]);
        continue;
      }
      const kind = classify(o);
      if (kind) msgs.push(new Msg(line, kind, o));
      else bad.push([line, isDict(o) ? 'neither an SMS nor an MMS record' : 'line is not a JSON object']);
    }
    return { msgs, bad, blank };
  }

  /** An SMS Import / Export export (Fig, TAK) in a ZIP archive opened with SieZip.openZip. */
  function sieFromZip(zip, label) {
    const found = zip.names.filter((n) => n.split('/').pop() === 'messages.ndjson');
    const ndjson = found.reduce((a, b) => (b.length < a.length ? b : a));
    const prefix = ndjson.slice(0, -'messages.ndjson'.length) + 'data/';
    const members = new Map();
    for (const n of zip.names) if (n.startsWith(prefix) && !n.endsWith('/')) members.set(n.slice(prefix.length), n);
    return {
      kind: 'zip', format: 'sie', describe: DESCRIBE.sie, unit: 'line',
      label,
      names: new Set(members.keys()),
      readNdjson: () => zip.read(ndjson),
      readPart: (name) => zip.read(members.get(name)),
      partSize: (name) => zip.entries.get(members.get(name)).usize,
      load: async () => parseNdjson(await zip.read(ndjson)),
    };
  }

  /** A backup in a ZIP archive opened with SieZip.openZip; the format is detected from
   *  the archive's contents (the same rules as cli/sie_to_sbr.py's open_source). */
  async function sourceFromZip(zip, label) {
    const names = zip.names;
    if (names.some((n) => n.split('/').pop() === 'messages.ndjson')) return sieFromZip(zip, label);
    if (names.some((n) => /^conversations\/conv_[0-9]+$/.test(n))) return buggyFromZip(zip, label);
    if (names.some((n) => n === 'sms.xml' || n === 'mms.xml' || n === '_pom_backup_manifest.json')) {
      return xmlSource('pom', label, 'zip', ['sms.xml', 'mms.xml'].filter((n) => names.includes(n)).map((n) => () => zip.stream(n)), zip);
    }
    const tops = names.filter((n) => !n.includes('/') && n.toLowerCase().endsWith('.xml'));
    if (tops.length) {
      const root = await xmlRoot(zip.stream(tops[0]));
      if (root === 'smses') return xmlSource('sbr', label, 'zip', [() => zip.stream(tops[0])], zip);
      if (root === 'messages') return xmlSource('wonder', label, 'zip', [() => zip.stream(tops[0])], zip);
    }
    throw new Error('This ZIP file is not a backup this converter knows. Choose a backup from a Fig or TAK phone ' +
      '(SMS Import / Export), SMS Backup & Restore, Wonder, Pom or Buggy Backup.');
  }

  /** A backup that is a plain XML file (SMS Backup & Restore, or Wonder without attachments). */
  async function sourceFromXmlFile(blob, label) {
    const chunks = () => blobChunks(blob);
    const root = await xmlRoot(chunks());
    if (root === 'smses') return xmlSource('sbr', label, 'file', [chunks], null);
    if (root === 'messages') return xmlSource('wonder', label, 'file', [chunks], null);
    if (root === 'calls') throw new Error('This is a call log backup (calls-….xml), not a message backup.');
    throw new Error('This file is not a message backup this converter knows. Choose a backup from a Fig or TAK phone ' +
      '(SMS Import / Export), SMS Backup & Restore, Wonder, Pom or Buggy Backup.');
  }

  /** An extracted SMS Import / Export export: files = [{path, size, read() -> Uint8Array}]. */
  function sourceFromFiles(files, label) {
    const found = files.filter((f) => f.path.split('/').pop() === 'messages.ndjson');
    if (!found.length) {
      throw new Error('There is no messages.ndjson in this folder. Choose the folder that contains ' +
        'messages.ndjson and the data folder.');
    }
    const nd = found.reduce((a, b) => (b.path.length < a.path.length ? b : a));
    const prefix = nd.path.slice(0, -'messages.ndjson'.length) + 'data/';
    const partsByName = new Map();
    for (const f of files) {
      const rest = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : '';
      if (rest && !rest.includes('/')) partsByName.set(rest, f);
    }
    return {
      kind: 'folder', format: 'sie', describe: DESCRIBE.sie, unit: 'line',
      label,
      names: new Set(partsByName.keys()),
      readNdjson: () => nd.read(),
      readPart: (name) => partsByName.get(name).read(),
      partSize: (name) => partsByName.get(name).size,
      load: async () => parseNdjson(await nd.read()),
    };
  }

  async function* blobChunks(blob) {
    const reader = blob.stream().getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  }

  /** Attachments that a backup keeps inside its XML as base64 (SMS Backup & Restore, Pom),
   *  decoded while reading and kept as Blobs, which browsers can move out of memory. Each
   *  one is named ATT_<n>, n counting in document order. */
  class AttachmentStore {
    constructor() {
      this.blobs = new Map();
      this.count = 0;
    }

    /** Stores base64 text; returns its name. Text that is not valid base64 gets a name too,
     *  but no data, so the part is reported as an attachment missing from the backup. */
    add(text) {
      this.count += 1;
      const name = 'ATT_' + this.count;
      const b64 = text.replace(/[ \t\r\n]/g, '');
      if (b64.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(b64)) this.blobs.set(name, new Blob([unbase64(b64)]));
      return name;
    }
  }

  const XML_SPACE = new Set([' ', '\t', '\n', '\r']);

  /** An XML attribute value as an XML parser reports it: line breaks and tabs become
   *  spaces (XML's attribute-value normalization), entities and character references are
   *  replaced. */
  function attrValue(raw) {
    let v = raw.indexOf('\r') >= 0 ? raw.replace(/\r\n?/g, '\n') : raw;
    if (/[\n\t]/.test(v)) v = v.replace(/[\n\t]/g, ' ');
    if (v.indexOf('&') < 0) return v;
    return v.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
      if (e[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) ? String.fromCodePoint(cp) : '�';
    });
  }

  /** A small streaming XML reader, enough for message backups (everything is in
   *  attributes): it reports elements with their attributes in document order, and skips
   *  the declaration, processing instructions, comments, CDATA, DOCTYPE and text. A start
   *  tag may be any size (an attachment's base64 can be tens of MB). */
  class XmlReader {
    constructor(onStart, onEnd) {
      this.onStart = onStart;
      this.onEnd = onEnd;
      this.buf = '';
      this.scan = -1;     // while inside a start tag: where to continue looking for its end
      this.quote = '';
      this.tagStart = 0;
    }

    feed(text) {
      this.buf += text;
      this.run(false);
    }

    finish() {
      this.run(true);
      if (this.scan >= 0 || this.buf.indexOf('<') >= 0) throw new Error('The XML file ends in the middle of a tag.');
    }

    run(atEnd) {
      const buf = this.buf;
      let i = 0;
      for (;;) {
        if (this.scan < 0) {
          const lt = buf.indexOf('<', i);
          if (lt < 0) {
            i = buf.length;
            break;
          }
          i = lt;
          if (buf.length - i < 9 && !atEnd) break;
          const c = buf[i + 1];
          if (c === '?' || c === '!') {
            let e;
            if (c === '?') e = indexEnd(buf, '?>', i + 2);
            else if (buf.startsWith('<!--', i)) e = indexEnd(buf, '-->', i + 4);
            else if (buf.startsWith('<![CDATA[', i)) e = indexEnd(buf, ']]>', i + 9);
            else e = declarationEnd(buf, i + 2);
            if (e < 0) break;
            i = e;
            continue;
          }
          if (c === '/') {
            const e = buf.indexOf('>', i + 2);
            if (e < 0) break;
            this.onEnd(buf.slice(i + 2, e).trim());
            i = e + 1;
            continue;
          }
          this.tagStart = i;
          this.scan = i + 1;
          this.quote = '';
        }
        let p = this.scan, gt = -1;
        while (p < buf.length) {
          if (this.quote) {
            const q = buf.indexOf(this.quote, p);
            if (q < 0) {
              p = buf.length;
              break;
            }
            this.quote = '';
            p = q + 1;
            continue;
          }
          const ch = buf[p];
          if (ch === '"' || ch === "'") this.quote = ch;
          else if (ch === '>') {
            gt = p;
            break;
          }
          p++;
        }
        if (gt < 0) {
          this.scan = p;
          break;
        }
        this.startTag(buf.slice(this.tagStart + 1, gt));
        this.scan = -1;
        i = gt + 1;
      }
      if (this.scan >= 0) {
        this.buf = buf.slice(this.tagStart);
        this.scan -= this.tagStart;
        this.tagStart = 0;
      } else {
        this.buf = buf.slice(i);
      }
    }

    startTag(s) {
      let end = s.length, k = end - 1;
      while (k >= 0 && XML_SPACE.has(s[k])) k--;
      const selfClose = k >= 0 && s[k] === '/';
      if (selfClose) end = k;
      let p = 0;
      while (p < end && !XML_SPACE.has(s[p]) && s[p] !== '/') p++;
      const name = s.slice(0, p);
      const attrs = [];
      for (;;) {
        while (p < end && XML_SPACE.has(s[p])) p++;
        if (p >= end) break;
        const eq = s.indexOf('=', p);
        if (eq < 0 || eq >= end) break;
        const key = s.slice(p, eq).trim();
        p = eq + 1;
        while (p < end && XML_SPACE.has(s[p])) p++;
        const q = s[p];
        if (q !== '"' && q !== "'") break;
        const close = s.indexOf(q, p + 1);
        if (close < 0 || close > end) break;
        attrs.push([key, attrValue(s.slice(p + 1, close))]);
        p = close + 1;
      }
      this.onStart(name, attrs);
      if (selfClose) this.onEnd(name);
    }
  }

  function indexEnd(buf, token, from) {
    const e = buf.indexOf(token, from);
    return e < 0 ? -1 : e + token.length;
  }

  /** The end of a <!DOCTYPE ...> (or other <!...>) declaration, with its internal subset. */
  function declarationEnd(buf, from) {
    let depth = 0, quote = '';
    for (let p = from; p < buf.length; p++) {
      const ch = buf[p];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '>' && depth <= 0) return p + 1;
    }
    return -1;
  }

  /** Feeds a stream of UTF-8 bytes (an async iterable of Uint8Array) to an XmlReader. */
  async function readXml(chunks, onStart, onEnd, stopEarly) {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    const reader = new XmlReader(onStart, onEnd);
    let stopped = false;
    for await (const chunk of chunks) {
      reader.feed(decoder.decode(chunk, { stream: true }));
      if (stopEarly && stopEarly()) {
        stopped = true;
        break;
      }
    }
    if (!stopped) {
      reader.feed(decoder.decode());
      reader.finish();
    }
  }

  /** The name of an XML document's root element, or null. */
  async function xmlRoot(chunks) {
    let root = null;
    try {
      await readXml(chunks, (name) => { if (root === null) root = name; }, () => {}, () => root !== null);
    } catch (e) {
      return null;
    }
    return root;
  }

  function fromAttrs(attrs, skip) {
    const o = {};
    for (const [k, v] of attrs) if (!(skip && skip.has(k)) && k !== '__proto__') o[k] = v === 'null' ? null : v;
    return o;
  }

  const SMS_SKIP = new Set(['readable_date', 'contact_name']);
  const MMS_SKIP = new Set(['address', 'readable_date', 'contact_name']);
  const PART_SKIP = new Set(['data', '_data_b64', 'file']);

  /** Turns the elements of an XML backup into records, as cli/sie_to_sbr.py's xml_records
   *  does: flavor 'sbr', 'wonder' or 'pom'; emit(kind, record) in document order. */
  function xmlRecords(flavor, store, emit) {
    let root = null, mms = null, parts = [], rows = [], recips = [];
    return {
      start(tag, list) {
        if (root === null) {
          root = tag;
          return;
        }
        const a = new Map(list);
        if (mms === null) {
          if (tag === 'sms') {
            const o = fromAttrs(list, SMS_SKIP);
            if (a.get('body') === 'null') o.body = 'null';  // a text that says "null"
            const name = a.get('contact_name');
            if (name !== undefined && name !== '' && name !== 'null' && name !== '(Unknown)') o.__display_name = name;
            emit('sms', o);
          } else if (tag === 'mms') {
            mms = fromAttrs(list, MMS_SKIP);
            parts = [];
            rows = [];
            recips = [];
          }
        } else if (tag === 'part') {
          const p = fromAttrs(list, PART_SKIP);
          if (!a.has('seq')) p.seq = a.get('ct') === 'application/smil' ? '-1' : '0';
          const b64 = a.get('_data_b64');
          if (flavor === 'sbr' && a.has('data')) p._data = store.add(a.get('data'));
          else if (flavor === 'pom' && b64 !== undefined && b64 !== '' && b64 !== 'null') p._data = store.add(b64);
          else if (flavor === 'wonder' && a.get('file')) p._data = a.get('file').replace(/\\/g, '/').split('/').pop();
          parts.push(p);
        } else if (tag === 'addr') {
          const r = fromAttrs(list);
          if (flavor === 'pom' && r.address) r.address = r.address.replace(/\/TYPE=PLMN$/i, '');
          rows.push(r);
        } else if (tag === 'r' && flavor === 'pom' && a.get('address')) {
          recips.push(a.get('address'));
        }
      },
      end(tag) {
        if (tag !== 'mms' || mms === null) return;
        if (!rows.length) rows = recips.map((x) => ({ address: x, type: '151', charset: '106' }));
        rows = rows.map((r, i) => (hasOwn(r, '_id') ? r : Object.assign({ _id: String(i + 1) }, r)));
        const sender = rows.find((r) => r.type === '137');
        if (sender !== undefined) mms.__sender_address = sender;
        mms.__recipient_addresses = rows.filter((r) => r !== sender);
        mms.__parts = parts;
        emit('mms', mms);
        mms = null;
      },
    };
  }

  /** A backup kept in XML: SMS Backup & Restore (a .xml file, or one inside a ZIP), Wonder
   *  (a ZIP with one XML file and mms_attachments/) or Pom (a ZIP with sms.xml and mms.xml).
   *  members: functions that each return the bytes of one XML document. */
  function xmlSource(format, label, kind, members, zip) {
    const store = new AttachmentStore();
    const files = new Map();
    if (format === 'wonder' && zip) {
      for (const n of zip.names) {
        if (n.startsWith('mms_attachments/') && !n.endsWith('/') && !files.has(n.split('/').pop())) files.set(n.split('/').pop(), n);
      }
    }
    const src = {
      kind, format, describe: DESCRIBE[format], unit: 'record', label,
      names: new Set(files.keys()),
      readPart: async (name) => (files.has(name) ? zip.read(files.get(name)) : new Uint8Array(await store.blobs.get(name).arrayBuffer())),
      partSize: (name) => (files.has(name) ? zip.entries.get(files.get(name)).usize : store.blobs.get(name).size),
      async load(onBytes) {
        const msgs = [];
        let record = 0;
        for (const member of members) {
          const b = xmlRecords(format, store, (k, o) => msgs.push(new Msg(++record, k, o)));
          try {
            await readXml(member(), (t, a) => b.start(t, a), (t) => b.end(t));
          } catch (e) {
            throw new Error("The backup's XML is damaged (" + e.message + ').');
          }
        }
        if (format !== 'wonder') src.names = new Set(store.blobs.keys());
        return { msgs, bad: [], blank: 0 };
      },
    };
    return src;
  }

  /** A Buggy Backup ZIP: conversations/conv_<n>, each one SMS as JSON with one-letter keys
   *  (BUGGY_KEYS). It holds no MMS. */
  function buggyFromZip(zip, label) {
    const entries = zip.names.map((n) => [n, /^conversations\/conv_([0-9]+)$/.exec(n)]).filter(([, m]) => m)
      .sort((a, b) => cmpBig(BigInt(a[1][1]), BigInt(b[1][1])) || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([n]) => n);
    return {
      kind: 'zip', format: 'buggy', describe: DESCRIBE.buggy, unit: 'record', label,
      names: new Set(),
      readPart: async (name) => { throw new Error('no attachment ' + name); },
      partSize: () => 0,
      async load() {
        const msgs = [], bad = [];
        const decoder = new TextDecoder('utf-8', { fatal: true });
        let record = 0;
        for (const name of entries) {
          record += 1;
          let obj;
          try {
            obj = JSON.parse(decoder.decode(await zip.read(name)));
          } catch (e) {
            bad.push([record, 'unreadable entry ' + name + ': ' + e.message]);
            continue;
          }
          if (!isDict(obj)) {
            bad.push([record, 'entry ' + name + ' is not a JSON object']);
            continue;
          }
          const o = {};
          for (const [key, col] of BUGGY_KEYS) if (hasOwn(obj, key)) o[col] = obj[key];
          if (classify(o)) msgs.push(new Msg(record, 'sms', o));
          else bad.push([record, 'entry ' + name + ' has neither an address nor a text']);
        }
        return { msgs, bad, blank: 0 };
      },
    };
  }

  async function load(src) {
    return src.load();
  }

  // ----------------------------------------------------------------------- planning

  const setKey = (keys) => JSON.stringify(Array.from(new Set(keys)).sort());

  /** Decisions that need the whole export: the owner's number and each MMS's conversation. */
  class Plan {
    constructor(msgs, ownerOverride) {
      this.msgs = msgs;
      [this.owner, this.ownerHow] = this.detectOwner(ownerOverride);
      this.names = new Map();
      for (const m of msgs) {
        for (const r of m.kind === 'sms' ? [m.o] : mmsAddrRows(m.o)) {
          const name = pick(r, K_NAME), a = sval(r, 'address');
          if (typeof name === 'string' && name && a && !this.names.has(addrKey(a))) this.names.set(addrKey(a), name);
        }
      }
      this.problems = new Map();
      this.threadLists = this.conversationAddresses();
    }

    detectOwner(override) {
      if (override) {
        return [new Set(override.split(',').filter((x) => x.trim()).map(addrKey)), 'set manually'];
      }
      const senders = new Map();
      for (const m of this.msgs) {
        if (m.kind !== 'mms' || sval(m.o, 'msg_box') !== '2') continue;
        for (const r of mmsAddrRows(m.o)) {
          const a = sval(r, 'address');
          if (sval(r, 'type') === '137' && a && a !== INSERT_TOKEN) senders.set(addrKey(a), (senders.get(addrKey(a)) || 0) + 1);
        }
      }
      if (senders.size) return [new Set(senders.keys()), 'the sender ("From") of the sent MMS'];
      const received = new Map();
      let n = 0;
      for (const m of this.msgs) {
        if (m.kind !== 'mms' || sval(m.o, 'msg_box') !== '1') continue;
        n += 1;
        const keys = new Set();
        for (const r of mmsAddrRows(m.o)) if (sval(r, 'type') !== '137') keys.add(addrKey(sval(r, 'address')));
        for (const k of keys) received.set(k, (received.get(k) || 0) + 1);
      }
      if (received.size) {
        const ranked = Array.from(received.entries()).sort((a, b) => b[1] - a[1]);
        const [k, c] = ranked[0];
        if (c >= 0.5 * n && (ranked.length === 1 || ranked[1][1] < c)) {  // a tie is ambiguous
          return [new Set([k]), 'the recipient of most received MMS'];
        }
      }
      return [new Set(), 'not found (set it manually)'];
    }

    /** Everyone in an MMS's From/To/Cc/Bcc headers except the phone's owner, as written. */
    others(o) {
      const out = [], seen = new Set();
      for (const r of mmsAddrRows(o)) {
        const a = sval(r, 'address');
        if (!a || a === INSERT_TOKEN) continue;
        const k = addrKey(a);
        if (!this.owner.has(k) && !seen.has(k)) {
          seen.add(k);
          out.push(a);
        }
      }
      return out;
    }

    static ownAddress(o) {
      for (const r of mmsAddrRows(o)) {
        const a = sval(r, 'address');
        if (a && a !== INSERT_TOKEN) return [a];
      }
      return [];
    }

    /** For each old conversation (thread_id): the participants most of its MMS list. Every
     *  MMS of the conversation gets this list as its "address" attribute, which Android uses
     *  on restore to put the message into a conversation. */
    conversationAddresses() {
      const byThread = new Map();
      for (const m of this.msgs) {
        const t = sval(m.o, 'thread_id');
        if (m.kind !== 'mms' || t === null) continue;
        if (!byThread.has(t)) byThread.set(t, []);
        byThread.get(t).push(m);
      }
      const lists = new Map();
      for (const [t, ms] of byThread) {
        const keyed = ms.map((m) => [setKey(this.others(m.o).map(addrKey)), m]);
        const counts = new Map();
        for (const [k] of keyed) counts.set(k, (counts.get(k) || 0) + 1);
        const rank = (k) => { const s = JSON.parse(k); return [counts.get(k), s.length, s]; };
        let best = null;
        for (const k of counts.keys()) if (best === null || cmpList(rank(k), rank(best)) > 0) best = k;
        let rep = null;
        for (const [k, m] of keyed) {
          if (k !== best) continue;
          if (rep === null || cmpBig(m.dateMs ?? 0n, rep.dateMs ?? 0n) < 0 ||
              ((m.dateMs ?? 0n) === (rep.dateMs ?? 0n) && m.line < rep.line)) rep = m;
        }
        const list = this.others(rep.o);
        lists.set(t, list.length ? list : Plan.ownAddress(rep.o));
      }
      return lists;
    }

    addressList(m) {
      const t = sval(m.o, 'thread_id');
      if (t !== null && this.threadLists.has(t)) return this.threadLists.get(t);
      const list = this.others(m.o);
      return list.length ? list : Plan.ownAddress(m.o);
    }

    contactNames(m, addresses) {
      const own = new Map();
      for (const r of mmsAddrRows(m.o)) {
        const name = pick(r, K_NAME), a = sval(r, 'address');
        if (typeof name === 'string' && name && a && !own.has(addrKey(a))) own.set(addrKey(a), name);
      }
      return addresses.map((a) => own.get(addrKey(a)) || this.names.get(addrKey(a)) || '(Unknown)').join(', ');
    }

    /** Why a record cannot be written as a restorable message, or null. */
    problem(m) {
      if (!this.problems.has(m)) this.problems.set(m, this._problem(m));
      return this.problems.get(m);
    }

    _problem(m) {
      const o = m.o;
      if (m.kind === 'sms') {
        for (const k of ['address', 'date', 'type']) if (!sval(o, k)) return 'no "' + k + '" value';
        if (!isInt(sval(o, 'date'))) return '"date" is not a number';
        return null;
      }
      if (!isInt(sval(o, 'date'))) return 'no numeric "date" value';
      if (!sval(o, 'msg_box')) return 'no "msg_box" value';
      if (!this.addressList(m).length) return 'no sender or recipient address';
      return null;
    }
  }

  const MEDIA_RE = /[\n&<>"]|[\uD800-\uDBFF][\uDC00-\uDFFF]/;

  /** A small, representative test set; the same selection as the Python version. */
  function pickSample(msgs, plan, byChat) {
    const byThread = new Map();
    for (const m of msgs) {
      const t = byChat ? chatKey(plan, m) : sval(m.o, 'thread_id');
      if (!byThread.has(t)) byThread.set(t, []);
      byThread.get(t).push(m);
    }
    const media = (m) => m.kind === 'mms' && mmsParts(m.o).some((p) => partFile(p));
    const group = (m) => m.kind === 'mms' && plan.addressList(m).length > 1;
    const newest = (ms) => ms.slice().sort((a, b) => cmpBig(b.dateMs ?? 0n, a.dateMs ?? 0n));
    const box = (m) => sval(m.o, 'msg_box');

    let chosen = [], best = null;
    for (const [t, ms] of byThread) {
      const sms = ms.filter((m) => m.kind === 'sms');
      const mms = ms.filter((m) => m.kind === 'mms');
      if (t === null || mms.some(group)) continue;
      const score = [['1', '2'].filter((b) => mms.some((m) => media(m) && box(m) === b)).length,
        new Set(sms.map((m) => sval(m.o, 'type'))).size, ms.length];
      if (best === null || cmpList(score, best[0]) > 0) best = [score, t];
    }
    if (best) {
      const ms = newest(byThread.get(best[1]));
      const sms = ms.filter((m) => m.kind === 'sms');
      const picked = sms.slice(0, 10);
      for (const typ of ['1', '2']) {
        if (!picked.some((m) => sval(m.o, 'type') === typ)) {
          picked.push(...sms.filter((m) => sval(m.o, 'type') === typ).slice(0, 1));
        }
      }
      picked.push(...sms.filter((m) => !picked.includes(m) && MEDIA_RE.test(sval(m.o, 'body') || '')).slice(0, 3));
      for (const b of ['1', '2']) picked.push(...ms.filter((m) => media(m) && box(m) === b).slice(0, 1));
      picked.push(...ms.filter((m) => m.kind === 'mms' && !media(m)).slice(0, 1));
      chosen = chosen.concat(picked);
    }
    let biggest = null;
    for (const [t, ms] of byThread) {
      if (t === null || !ms.some(group)) continue;
      const g = [ms.length, t];
      if (biggest === null || cmpList(g, biggest) > 0) biggest = g;
    }
    if (biggest) {
      const ms = newest(byThread.get(biggest[1]).filter((m) => m.kind === 'mms'));
      chosen.push(...ms.filter((m) => media(m) && box(m) === '1').slice(0, 1));
      chosen.push(...ms.filter((m) => !media(m) && box(m) === '1').slice(0, 2));
      chosen.push(...ms.filter((m) => box(m) === '2').slice(0, 1));
    }
    const unique = new Map();
    for (const m of chosen) unique.set(m.line, m);
    return Array.from(unique.keys()).sort((a, b) => a - b).map((k) => unique.get(k));
  }

  // ----------------------------------------------------------------------- convert

  class Converter {
    constructor(src, plan, options) {
      this.src = src;
      this.plan = plan;
      this.opts = options;
      this.changes = [];       // [line, kind, field, count, characters] for text XML cannot hold
      this.notes = new Map();  // line -> notes for the manifest and report
      this.stats = { attachments: 0, attachment_bytes: 0, attachments_empty: 0,
        attachments_missing: 0, mms_address_from_conversation: 0 };
    }

    note(line, text) {
      if (!this.notes.has(line)) this.notes.set(line, []);
      this.notes.get(line).push(text);
    }

    text(value, m, field) {
      if (value && XML_ILLEGAL.test(value)) {
        const found = value.match(XML_ILLEGAL_ALL);
        const chars = Array.from(new Set(found.map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')))).sort();
        this.changes.push([m.line, m.kind, field, found.length, chars]);
        this.note(m.line, found.length + ' character(s) ' + chars.join('/') + ' ' +
          (this.opts.nul === 'strip' ? 'removed' : 'replaced by U+FFFD') + ' from ' + field);
        value = clean(value, this.opts.nul);
      }
      return esc(value);
    }

    tag(indent, name, attrs, m, prefix = '', end = ' />') {
      let s = indent + '<' + name;
      for (const [k, v] of attrs) s += ' ' + k + '="' + this.text(v, m, prefix + k) + '"';
      return s + end + '\n';
    }

    sms(m) {
      const o = m.o, attrs = [];
      for (const k of SMS_ORDER) {
        let v;
        if (k === 'sub_id') v = subIdFor(o, this.opts.subId);
        else if (k === 'readable_date') v = readable(m.dateMs, this.opts.tz);
        else if (k === 'contact_name') {
          const name = pick(o, K_NAME);
          v = typeof name === 'string' && name ? name : '(Unknown)';
        } else {
          v = sval(o, k);
          if (v === null && !SMS_OMIT.has(k)) v = 'null';
        }
        if (v !== null) attrs.push([k, v]);
      }
      return this.tag('  ', 'sms', attrs, m);
    }

    /** Returns the <mms> element and the attachment bytes of each part (null if none). */
    async mms(m) {
      const o = m.o, attrs = [];
      const addresses = this.plan.addressList(m);
      const own = setKey(this.plan.others(o).map(addrKey));
      if (own !== setKey(addresses.map(addrKey)) && own !== '[]') {
        this.note(m.line, 'MMS headers list ' + JSON.parse(own).length + ' other participant(s); "address" uses the ' +
          addresses.length + ' of its conversation so it stays in that conversation');
        this.stats.mms_address_from_conversation += 1;
      }
      for (const k of MMS_ORDER) {
        let v;
        if (k === 'date') v = m.dateMs.toString();
        else if (k === 'address') v = addresses.join('~');
        else if (k === 'sub_id') v = subIdFor(o, this.opts.subId);
        else if (k === 'readable_date') v = readable(m.dateMs, this.opts.tz);
        else if (k === 'contact_name') v = this.plan.contactNames(m, addresses);
        else {
          v = sval(o, k);
          if (v === null && !MMS_OMIT.has(k)) v = 'null';
        }
        if (v !== null) attrs.push([k, v]);
      }
      const out = [this.tag('  ', 'mms', attrs, m, '', '>'), '    <parts>\n'];
      const datas = [];
      for (const p of writtenParts(o, this.opts)) {
        let line = this.tag('      ', 'part', PART_ATTRS.map((k) => [k, sval(p, k) !== null ? sval(p, k) : 'null']), m, 'part.', '');
        line = line.slice(0, -1);
        const name = partFile(p);
        let data = null;
        if (name) {
          this.stats.attachments += 1;
          if (this.src.names.has(name)) {
            data = await this.src.readPart(name);
            line += ' data="' + base64(data) + '"';
            this.stats.attachment_bytes += data.length;
            if (!data.length) {
              this.stats.attachments_empty += 1;
              this.note(m.line, 'attachment ' + name + ' (' + sval(p, 'ct') + ') is an empty (0-byte) file in the export');
            }
          } else {
            this.stats.attachments_missing += 1;
            this.note(m.line, 'attachment file ' + name + ' (' + sval(p, 'ct') + ') is not in the export; part written without data');
          }
        }
        datas.push(data);
        out.push(line + ' />\n');
      }
      out.push('    </parts>\n    <addrs>\n');
      for (const r of mmsAddrRows(o)) {
        out.push(this.tag('      ', 'addr', ADDR_ATTRS.map((k) => [k, sval(r, k) !== null ? sval(r, k) : 'null']), m, 'addr.'));
      }
      out.push('    </addrs>\n  </mms>\n');
      return { xml: out.join(''), datas };
    }
  }

  function tzLabel(tz) {
    return tz || localTimeZone() + " (this device's time zone)";
  }

  function header(count, options, now) {
    return "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n" +
      '<!--Converted by ' + APP + ' ' + VERSION + ' on ' + localStamp(now) +
      '. readable_date values are in ' + tzLabel(options.tz) + '.-->\n' +
      '<?xml-stylesheet type="text/xsl" href="sms.xsl"?>\n' +
      '<smses count="' + count + '" backup_set="' + uuid4() + '" backup_date="' + now.getTime() + '" type="full">\n';
  }

  const DEFAULTS = { to: 'sbr', keep: 'all', noGroups: false, noPdf: false, splitMb: 0, sample: false,
    subId: 'unknown', tz: null, nul: 'strip', owner: null, verify: true };

  /** Splits the records into problems and convertible ones, applies the "what to keep"
   *  options and picks the test sample (cli/sie_to_sbr.py's choose). */
  function choose(src, loaded, plan, options) {
    const problems = [], ok = [], kept = [];
    const leftOut = { sms: 0, mms: 0, groups: 0, pdf: 0 };
    for (const m of loaded.msgs) {
      const why = plan.problem(m);
      if (why) problems.push([m, why]);
      else ok.push(m);
    }
    for (const m of ok) {
      if (options.keep === 'sms' && m.kind !== 'sms') leftOut.mms += 1;
      else if (options.keep === 'mms' && m.kind !== 'mms') leftOut.sms += 1;
      else if (options.noGroups && m.kind === 'mms' && plan.addressList(m).length > 1) leftOut.groups += 1;
      else kept.push(m);
    }
    const chosen = options.sample ? pickSample(kept, plan, src.format !== 'sie') : kept;
    if (options.noPdf) for (const m of chosen) if (m.kind === 'mms') leftOut.pdf += mmsParts(m.o).filter(isPdf).length;
    return { problems, ok, chosen, leftOut };
  }

  /** The conversation a message is restored into: its participants, without the owner. */
  function chatKey(plan, m) {
    if (m.kind === 'sms') return addrKey(sval(m.o, 'address'));
    return Array.from(new Set(plan.addressList(m).map(addrKey))).sort().join(',');
  }

  /** About how many bytes the message takes in the output (attachments exactly). */
  function estimate(m, src, options) {
    const o = m.o;
    if (m.kind === 'sms') return 200 + u8len(sval(o, 'body')) + u8len(sval(o, 'address'));
    let n = 1000 + 100 * mmsAddrRows(o).length;
    for (const p of writtenParts(o, options)) {
      n += 200 + u8len(sval(p, 'text'));
      const name = partFile(p);
      if (name && src.names.has(name)) {
        const size = src.partSize(name);
        n += options.to === 'sbr' ? 4 * Math.floor((size + 2) / 3) : size;
      }
    }
    return n;
  }

  /** About how many bytes all of the job's output files take together. */
  function estimateTotal(job) {
    return job.chosen.reduce((n, m) => n + estimate(m, job.src, job.options), 0);
  }

  /** The messages of each output file. With splitMb, a conversation goes into one file
   *  whenever it fits, a message is never split, and files hold their messages in the
   *  original order; restored one after another, they give back every message. */
  function splitMessages(chosen, src, plan, options) {
    const limit = Math.trunc((options.splitMb || 0) * 1048576);
    if (limit <= 0) return [chosen];
    const chats = new Map();
    for (const m of chosen) {
      const k = chatKey(plan, m);
      if (!chats.has(k)) chats.set(k, []);
      chats.get(k).push(m);
    }
    const parts = [];
    let cur = [], size = 0;
    for (const ms of chats.values()) {
      const sizes = ms.map((m) => estimate(m, src, options));
      if (cur.length && size + sizes.reduce((a, b) => a + b, 0) > limit) {
        parts.push(cur);
        cur = [];
        size = 0;
      }
      ms.forEach((m, i) => {
        if (cur.length && size + sizes[i] > limit) {
          parts.push(cur);
          cur = [];
          size = 0;
        }
        cur.push(m);
        size += sizes[i];
      });
    }
    if (cur.length) parts.push(cur);
    const index = new Map(chosen.map((m, i) => [m, i]));
    return parts.map((p) => p.slice().sort((a, b) => index.get(a) - index.get(b)));
  }

  /** Everything decided before writing: what is written and how it is split into files.
   *  options: {to: 'sbr'|'fig'|'wonder', keep: 'all'|'sms'|'mms', noGroups, noPdf, splitMb,
   *  sample, subId: 'unknown'|'keep'|'<n>', tz, nul: 'strip'|'replace', owner, verify}. */
  function prepare({ src, loaded, options, now }) {
    options = Object.assign({}, DEFAULTS, options);
    const plan = new Plan(loaded.msgs, options.owner || null);
    const conv = new Converter(src, plan, options);
    const { problems, ok, chosen, leftOut } = choose(src, loaded, plan, options);
    const parts = splitMessages(chosen, src, plan, options);
    const ids = options.to === 'fig' ? figIds(chosen, plan) : null;
    return { src, loaded, plan, conv, problems, ok, chosen, leftOut, parts, ids, options, now: now || new Date() };
  }

  const zipLib = () => (typeof module === 'object' && module.exports ? require('./zip.js') : root.SieZip);
  const cancelled = (signal) => signal && signal.aborted;
  const abortError = () => (typeof DOMException === 'function' ? new DOMException('Cancelled', 'AbortError')
    : Object.assign(new Error('Cancelled'), { name: 'AbortError' }));

  /** Writes output file k (0-based) of the job to sink: {write(string|Uint8Array), close()}.
   *  Returns {msgs, verification}. */
  async function writePart(job, k, sink, { onProgress, signal } = {}) {
    const msgs = job.parts[k], o = job.options;
    let verification = null;
    if (o.to === 'sbr') {
      const verifier = o.verify ? new Verifier(job.plan, o, null, job.src.format) : null;
      await sink.write(header(msgs.length, o, job.now));
      for (let i = 0; i < msgs.length; i++) {
        if (cancelled(signal)) throw abortError();
        const m = msgs[i];
        let xml, datas = null;
        if (m.kind === 'sms') xml = job.conv.sms(m);
        else ({ xml, datas } = await job.conv.mms(m));
        if (verifier) verifier.check(xml, m, datas);
        await sink.write(xml);
        if (onProgress && (m.kind === 'mms' || i % 250 === 0)) await onProgress(i + 1, msgs.length);
      }
      await sink.write('</smses>\n');
      await sink.close();
      if (verifier) verification = verifier.finish({ chosen: msgs, options: o });
    } else {
      const { first, files } = o.to === 'fig' ? figPart(msgs, job.src, job.plan, o, job.conv, job.ids)
        : wonderPart(msgs, job.src, o, job.conv, job.now);
      const zip = zipLib().zipWriter(sink, job.now);
      await zip.add(first[0], first[1]);
      for (let i = 0; i < files.length; i++) {
        if (cancelled(signal)) throw abortError();
        await zip.add(files[i][0], await job.src.readPart(files[i][1]));
        if (onProgress) await onProgress(i + 1, files.length);
      }
      await zip.close();
      await sink.close();
      if (o.verify) verification = verifyZipPart(job, msgs, first, files);
    }
    if (onProgress) await onProgress(msgs.length, msgs.length);
    return { msgs, verification };
  }

  /** Counts an attachment and notes an empty or missing one (the same for every format). */
  function attachmentNote(conv, m, p, name, present, size) {
    conv.stats.attachments += 1;
    if (!present) {
      conv.stats.attachments_missing += 1;
      conv.note(m.line, 'attachment file ' + name + ' (' + sval(p, 'ct') + ') is not in the export; part written without data');
    } else {
      conv.stats.attachment_bytes += size;
      if (!size) {
        conv.stats.attachments_empty += 1;
        conv.note(m.line, 'attachment ' + name + ' (' + sval(p, 'ct') + ') is an empty (0-byte) file in the export');
      }
    }
  }

  /** Row and thread ids for records that come from another format (Fig's importer, SMS
   *  Import / Export, expects them): numbered in the order written, threads by participants. */
  function figIds(chosen, plan) {
    const ids = new Map(), threads = new Map();
    chosen.forEach((m, i) => {
      const key = chatKey(plan, m);
      if (!threads.has(key)) threads.set(key, String(threads.size + 1));
      ids.set(m, [String(i + 1), threads.get(key)]);
    });
    return ids;
  }

  const RELATIONS = new Set(['_id', 'thread_id', '__sender_address', '__recipient_addresses', '__parts']);

  /** messages.ndjson and its data/ files for one output file, as SMS Import / Export writes
   *  them. Records from an SMS Import / Export export are written back unchanged except for
   *  the options (SIM id, PDFs). */
  function figPart(msgs, src, plan, options, conv, ids) {
    const lines = [], files = [], seen = new Set();
    let k = 0;
    for (const m of msgs) {
      const o = m.o;
      let obj;
      if (src.format === 'sie') {
        obj = JSON.parse(JSON.stringify(o));
        const key = K_PARTS.find((x) => Array.isArray(obj[x]));
        if (m.kind === 'mms' && options.noPdf && key) obj[key] = obj[key].filter((p) => !(isDict(p) && isPdf(p)));
      } else {
        const [rid, tid] = ids.get(m);
        obj = { _id: rid, thread_id: tid };
        for (const key of Object.keys(o)) if (!RELATIONS.has(key)) obj[key] = o[key];
        if (options.subId !== 'keep') obj.sub_id = subIdFor(o, options.subId);
        if (m.kind === 'mms') {
          const d = sval(o, 'date');
          if (isInt(d) && BigInt(d) >= 100000000000n) obj.date = floorDiv1000(BigInt(d)).toString();
          const sender = o.__sender_address;
          if (isDict(sender)) obj.__sender_address = Object.assign({}, sender, { msg_id: rid });
          obj.__recipient_addresses = (Array.isArray(o.__recipient_addresses) ? o.__recipient_addresses : [])
            .filter(isDict).map((r) => Object.assign({}, r, { msg_id: rid }));
          obj.__parts = writtenParts(o, options).map((p) => Object.assign({}, p, { mid: rid }));
        }
      }
      if (src.format === 'sie' && options.subId !== 'keep') obj.sub_id = subIdFor(o, options.subId);
      if (m.kind === 'mms') {
        const parts = pick(obj, K_PARTS);
        for (const p of Array.isArray(parts) ? parts : []) {
          if (!isDict(p)) continue;
          const name = partFile(p);
          if (!name) continue;
          const present = src.names.has(name);
          attachmentNote(conv, m, p, name, present, present ? src.partSize(name) : 0);
          if (src.format === 'sie') {
            if (present && !seen.has(name)) {
              seen.add(name);
              files.push(['data/' + name, name]);
            }
          } else if (present) {
            k += 1;
            p._data = APP_PARTS + 'PART_' + k;
            files.push(['data/PART_' + k, name]);
          } else {
            delete p._data;
          }
        }
      }
      lines.push(JSON.stringify(obj));
    }
    return { first: ['messages.ndjson', new TextEncoder().encode(lines.join('\n') + '\n')], files };
  }

  function extFor(ct, label) {
    const base = (ct || '').split(';')[0].trim().toLowerCase();
    if (hasOwn(EXTENSIONS, base)) return EXTENSIONS[base];
    const m = /\.([A-Za-z0-9]{1,5})$/.exec(label || '');
    return m ? m[1].toLowerCase() : 'bin';
  }

  function wonderSmil(refs) {
    const tag = (ct) => (ct.startsWith('image/') ? 'img' : ct.startsWith('video/') ? 'video' : ct.startsWith('audio/') ? 'audio' : 'ref');
    return '<smil><head><layout><root-layout/><region id="Image" fit="meet" top="0" left="0" height="100%" ' +
      'width="100%"/></layout></head><body>' +
      refs.map(([ct, label]) => '<par dur="5000ms"><' + tag(ct) + ' src="' + esc(label) + '" region="Image"/></par>').join('') +
      '</body></smil>';
  }

  const ymd = (d) => pad(d.getFullYear(), 4) + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());

  /** The XML file and mms_attachments/ files of a Wonder backup. */
  function wonderPart(msgs, src, options, conv, now) {
    const out = ['<?xml version="1.0" encoding="UTF-8"?>\n<messages sms_count="' + msgs.filter((m) => m.kind === 'sms').length +
      '" mms_count="' + msgs.filter((m) => m.kind === 'mms').length + '">\n'];
    const files = [];
    let nMms = 0, k = 0;
    const or = (v, fb) => (v ? v : fb);
    for (const m of msgs) {
      const o = m.o;
      if (m.kind === 'sms') {
        out.push(conv.tag('  ', 'sms', [['address', or(sval(o, 'address'), '')], ['body', or(sval(o, 'body'), '')],
          ['date', sval(o, 'date')], ['date_sent', or(sval(o, 'date_sent'), '0')], ['type', sval(o, 'type')],
          ['read', or(sval(o, 'read'), '1')], ['seen', or(sval(o, 'seen'), '1')]], m));
        continue;
      }
      nMms += 1;
      const box = sval(o, 'msg_box');
      out.push(conv.tag('  ', 'mms', [['date', floorDiv1000(m.dateMs).toString()], ['read', or(sval(o, 'read'), '1')],
        ['msg_box', box], ['ct_t', or(sval(o, 'ct_t'), 'application/vnd.wap.multipart.related')],
        ['m_type', or(sval(o, 'm_type'), box === '1' ? '132' : '128')], ['seen', or(sval(o, 'seen'), '1')]], m, '', '>'));
      for (const r of mmsAddrRows(o)) {
        out.push(conv.tag('    ', 'addr', [['address', or(sval(r, 'address'), '')], ['type', or(sval(r, 'type'), '151')]], m, 'addr.'));
      }
      const parts = [], refs = [];
      const ps = writtenParts(o, options);
      for (const p of ps) {
        const ct = or(sval(p, 'ct'), 'application/octet-stream');
        let label = sval(p, 'cl') || sval(p, 'name');
        const name = partFile(p);
        const present = !!name && src.names.has(name);
        if (name) attachmentNote(conv, m, p, name, present, present ? src.partSize(name) : 0);
        if (present) {
          k += 1;
          const fn = 'mms_' + nMms + '_' + k + '.' + extFor(ct, label);
          label = label || fn;
          parts.push(conv.tag('    ', 'part', [['ct', ct], ['name', label], ['cl', label], ['file', fn]], m, 'part.'));
          files.push(['mms_attachments/' + fn, name]);
          refs.push([ct, label]);
        } else {
          const attrs = [['ct', or(sval(p, 'ct'), 'text/plain')]];
          if (label) attrs.push(['name', label], ['cl', label]);
          if (sval(p, 'text') !== null) attrs.push(['text', sval(p, 'text')]);
          parts.push(conv.tag('    ', 'part', attrs, m, 'part.'));
        }
      }
      if (refs.length && !ps.some((p) => sval(p, 'ct') === 'application/smil')) {
        parts.unshift(conv.tag('    ', 'part', [['ct', 'application/smil'], ['name', 'smil.xml'], ['cl', 'smil.xml'],
          ['text', wonderSmil(refs)]], m, 'part.'));
      }
      out.push(...parts, '  </mms>\n');
    }
    out.push('</messages>\n');
    return { first: ['Messages_Backup_' + ymd(now) + '.xml', new TextEncoder().encode(out.join(''))], files };
  }

  /** Checks a ZIP output before it is saved: its message file is read back with this
   *  converter's own reader and must hold exactly the messages written. */
  function verifyZipPart(job, msgs, first, files) {
    const errors = [], back = { sms: 0, mms: 0 };
    try {
      if (job.options.to === 'fig') {
        const r = parseNdjson(first[1]);
        for (const m of r.msgs) back[m.kind] += 1;
        if (r.bad.length) errors.push(r.bad.length + ' line(s) of messages.ndjson could not be read back');
      } else {
        const b = xmlRecords('wonder', new AttachmentStore(), (kind) => { back[kind] += 1; });
        const reader = new XmlReader((t, a) => b.start(t, a), (t) => b.end(t));
        reader.feed(new TextDecoder('utf-8', { fatal: true }).decode(first[1]));
        reader.finish();
      }
    } catch (e) {
      errors.push('the written ' + first[0] + ' could not be read back: ' + e.message);
    }
    const want = { sms: msgs.filter((m) => m.kind === 'sms').length, mms: msgs.filter((m) => m.kind === 'mms').length };
    if (!errors.length && (back.sms !== want.sms || back.mms !== want.mms)) {
      errors.push('read back ' + back.sms + ' SMS + ' + back.mms + ' MMS, expected ' + want.sms + ' SMS + ' + want.mms + ' MMS');
    }
    const lines = ['VERIFICATION (' + first[0] + ' read back with this converter\'s ' + TARGET_NAMES[job.options.to] + ' reader;',
      '              every attachment copied byte for byte from the backup, with its CRC-32)',
      '  messages read back:       ' + back.sms + ' SMS + ' + back.mms + ' MMS (written ' + want.sms + ' SMS + ' + want.mms + ' MMS)',
      '  attachments written:      ' + files.length,
      '  result: ' + (errors.length ? 'FAILED' : 'PASSED')].concat(errors.map((e) => '    ! ' + e));
    return { ok: !errors.length, errors, lines, conversations: null, split: [] };
  }

  // ----------------------------------------------------------------------- manifest and report

  function csvField(v) {
    if (v === null || v === undefined) return '';
    v = String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  /** One row per message written to one output file (msgs), identical to the Python
   *  version's .manifest.csv. */
  function manifest(job, msgs) {
    const { plan, conv, options } = job;
    const rows = [['xml_index', 'kind', 'direction', 'source_line', 'source_id', 'source_thread_id',
      'source_sub_id', 'written_sub_id', 'date_ms', 'date_utc', 'address_written', 'parts',
      'attachments', 'notes']];
    msgs.forEach((m, i) => {
      const o = m.o;
      const mms = m.kind === 'mms';
      const parts = mms ? writtenParts(o, options) : [];
      rows.push([i + 1, m.kind, m.direction, m.line, sval(o, '_id'), sval(o, 'thread_id'), sval(o, 'sub_id'),
        subIdFor(o, options.subId), m.dateMs.toString(), utc(m.dateMs),
        mms ? plan.addressList(m).join('~') : sval(o, 'address'),
        mms ? parts.length : '', mms ? parts.filter((p) => partFile(p)).length : '',
        (conv.notes.get(m.line) || []).join('; ')]);
    });
    return rows.map((r) => r.map(csvField).join(',') + '\r\n').join('');
  }

  function counted(items, f) {
    const c = new Map();
    for (const x of items) {
      const k = f(x);
      c.set(k, (c.get(k) || 0) + 1);
    }
    return Array.from(c.entries()).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([k, v]) => k + ' ' + v).join(', ');
  }

  /** Old conversations: thread_id values in an SMS Import / Export export; other formats
   *  have none, so their messages are grouped by participants. */
  function countConversations(src, msgs, plan) {
    if (src.format === 'sie') return new Set(msgs.map((m) => sval(m.o, 'thread_id'))).size;
    return new Set(msgs.filter((m) => !plan.problem(m)).map((m) => chatKey(plan, m))).size;
  }

  /** Facts about the export, for the summary screen and the report. */
  function summarize(src, loaded, plan) {
    const { msgs, bad, blank } = loaded;
    const sms = msgs.filter((m) => m.kind === 'sms');
    const mms = msgs.filter((m) => m.kind === 'mms');
    const allParts = [].concat(...mms.map((m) => mmsParts(m.o)));
    const refs = allParts.map(partFile).filter(Boolean);
    const found = refs.filter((r) => src.names.has(r));
    const empty = found.filter((r) => src.partSize(r) === 0).length;
    const dates = msgs.map((m) => m.dateMs).filter((d) => d !== null && d !== 0n);
    const min = dates.length ? dates.reduce((a, b) => (b < a ? b : a)) : null;
    const max = dates.length ? dates.reduce((a, b) => (b > a ? b : a)) : null;
    const refSet = new Set(refs);
    const count = (list, f) => list.filter(f).length;
    return {
      lines: msgs.length + bad.length + blank, blank, bad,
      sms: sms.length, smsReceived: count(sms, (m) => m.direction === 'received'), smsSent: count(sms, (m) => m.direction === 'sent'),
      mms: mms.length, mmsReceived: count(mms, (m) => m.direction === 'received'), mmsSent: count(mms, (m) => m.direction === 'sent'),
      parts: allParts.length, attachments: refs.length, present: found.length, missing: refs.length - found.length, empty,
      unreferenced: Array.from(src.names).filter((n) => !refSet.has(n)).length,
      conversations: countConversations(src, msgs, plan),
      owner: Array.from(plan.owner).sort().map(mask), ownerHow: plan.ownerHow,
      first: min, last: max,
      problems: msgs.filter((m) => plan.problem(m)).map((m) => [m.line, m.kind, plan.problem(m)]),
      text: [
        'SOURCE',
        '  name:              ' + src.label + ' (' + src.kind + ')',
        '  format:            ' + src.describe,
        '  records:           ' + (msgs.length + bad.length + blank) + (src.unit === 'line' ? ' lines' : ' records') +
          ' (' + blank + ' blank, ' + bad.length + ' unreadable)',
        '  SMS:               ' + sms.length + ' (' + counted(sms, (m) => m.direction) + ')',
        '  MMS:               ' + mms.length + ' (' + counted(mms, (m) => m.direction) + ')',
        '  MMS parts:         ' + allParts.length + ' (' + counted(allParts, (p) => (sval(p, 'ct') === 'application/smil'
          ? 'SMIL' : partFile(p) ? 'attachment' : 'text')) + ')',
        '  attachment files:  ' + refs.length + ' referenced, ' + found.length + ' present, ' + (refs.length - found.length) +
          ' missing, ' + empty + ' empty (0 bytes); ' + Array.from(src.names).filter((n) => !refSet.has(n)).length +
          ' file(s) not referenced by any part',
        '  conversations:     ' + countConversations(src, msgs, plan) + (src.format === 'sie' ? ' thread_id values' : ' (by participants)'),
        '  owner number:      ' + (Array.from(plan.owner).sort().map(mask).join(', ') || 'unknown') + ' (from ' + plan.ownerHow + ')',
        dates.length ? '  dates:             ' + utc(min, false) + ' .. ' + utc(max, false) : '  dates:             none',
        '  SIM sub_id values: ' + counted(msgs, (m) => String(sval(m.o, 'sub_id') ?? 'None')),
      ],
    };
  }

  /** Source fields with no place in the target format (reported, not hidden). */
  function notCarried(msgs, options) {
    const target = options.to || 'sbr';
    let known = null;
    if (target === 'wonder') {
      known = { sms: new Set(['address', 'body', 'date', 'date_sent', 'type', 'read', 'seen']),
        mms: new Set(['date', 'read', 'msg_box', 'ct_t', 'm_type', 'seen'].concat(K_PARTS, K_SENDER, K_RECIPS)),
        part: new Set(['ct', 'name', 'cl', 'text', '_data']), addr: new Set(['address', 'type']) };
    } else if (target === 'sbr') {
      known = { sms: new Set(SMS_ORDER.concat(K_NAME)), mms: new Set(MMS_ORDER.concat(K_PARTS, K_SENDER, K_RECIPS, K_NAME)),
        part: new Set(PART_ATTRS.concat(['_data'])), addr: new Set(ADDR_ATTRS.concat(K_NAME)) };
    }
    const c = new Map();
    const add = (k) => c.set(k, (c.get(k) || 0) + 1);
    for (const m of msgs) {
      if (known) {
        if (m.kind === 'sms') {
          for (const k of Object.keys(m.o)) if (!known.sms.has(k)) add('sms.' + k);
        } else {
          for (const k of Object.keys(m.o)) if (!known.mms.has(k)) add('mms.' + k);
          for (const p of mmsParts(m.o)) for (const k of Object.keys(p)) if (!known.part.has(k)) add('part.' + k);
          for (const r of mmsAddrRows(m.o)) for (const k of Object.keys(r)) if (!known.addr.has(k)) add('addr.' + k);
        }
      }
      if (options.subId !== 'keep' && sval(m.o, 'sub_id') !== null) add(m.kind + '.sub_id (old phone value)');
    }
    const lines = ['  source fields not stored in the ' + (target === 'fig' ? 'ZIP' : 'XML') + ' (no matching field in its format,',
      '  or specific to the old phone; ids and sub_id are kept in the manifest):'];
    const keys = Array.from(c.keys()).sort();
    for (const k of keys) lines.push('    ' + k.padEnd(34) + ' ' + c.get(k));
    if (!keys.length) lines.push('    none');
    return lines;
  }

  function describeFilters(options, leftOut) {
    const out = [];
    if (options.keep === 'sms') out.push('text messages (SMS) only, ' + leftOut.mms + ' MMS left out');
    else if (options.keep === 'mms') out.push('picture and group messages (MMS) only, ' + leftOut.sms + ' SMS left out');
    if (options.noGroups) out.push(leftOut.groups + ' group MMS left out');
    if (options.noPdf) out.push(leftOut.pdf + ' PDF attachment(s) left out');
    return out.join('; ') || 'none (everything is kept)';
  }

  /** The conversion report (.report.txt). files: [{name, bytes, verification}], one per
   *  output file, in order. */
  function report(job, files) {
    const { src, loaded, plan, conv, problems, chosen, options, leftOut } = job;
    const s = conv.stats;
    const unit = src.unit || 'line';
    const lines = ['Message backup conversion report (' + APP + ' ' + VERSION + '): ' + src.describe.split(':')[0] +
      ' -> ' + TARGET_NAMES[options.to], 'generated ' + localStamp(job.now), ''];
    lines.push(...summarize(src, loaded, plan).text, '', 'CONVERSION', '  output format:     ' + TARGET_NAMES[options.to]);
    for (const f of files) lines.push('  output:            ' + f.name + ' (' + f.bytes.toLocaleString('en-US') + ' bytes)');
    if (files.length > 1) {
      lines.push('  parts:             ' + files.length + ' files of at most about ' + options.splitMb +
        ' MB; restore them in order, part 1 first');
    }
    lines.push('  mode:              ' + (options.sample ? 'test sample' : 'all messages'),
      '  kept:              ' + describeFilters(options, leftOut),
      '  written:           ' + chosen.filter((m) => m.kind === 'sms').length + ' SMS + ' +
        chosen.filter((m) => m.kind === 'mms').length + ' MMS = ' + chosen.length + ' messages',
      '  attachments:       ' + (s.attachments - s.attachments_missing) + ' written (' + s.attachment_bytes.toLocaleString('en-US') +
        ' bytes), ' + s.attachments_empty + ' empty in the export, ' + s.attachments_missing + ' missing from the export',
      '  not convertible:   ' + (problems.length + loaded.bad.length) + ' record(s)' + (problems.length || loaded.bad.length ? '' : ' (none)'));
    for (const [m, why] of problems) lines.push('    ' + unit + ' ' + m.line + ' (' + m.kind + '): ' + why);
    for (const [line, why] of loaded.bad) lines.push('    ' + unit + ' ' + line + ': ' + why);
    lines.push('  sub_id (SIM):      ' + (options.subId === 'unknown'
      ? 'written as -1 ("SIM unknown") for every message; the old phone\'s values are in the manifest'
      : options.subId === 'keep' ? 'the old phone\'s values written unchanged' : 'written as ' + options.subId + ' for every message'));
    lines.push('  text changes:      ' + conv.changes.length + ' field(s) had characters XML cannot store (' +
      (options.nul === 'strip' ? 'removed' : 'replaced by U+FFFD') + ')' + (conv.changes.length ? '' : ' - none'));
    for (const [line, kind, field, n, chars] of conv.changes) lines.push('    ' + unit + ' ' + line + ' (' + kind + ' ' + field + '): ' + n + ' x ' + chars.join('/'));
    if (options.to === 'sbr') {
      lines.push('  MMS whose "address" comes from their conversation (headers list fewer people): ' + s.mms_address_from_conversation);
      for (const m of chosen) {
        if ((conv.notes.get(m.line) || []).some((n) => n.startsWith('MMS headers'))) lines.push('    ' + unit + ' ' + m.line + ' (thread ' + sval(m.o, 'thread_id') + ')');
      }
    }
    for (const m of chosen) for (const n of conv.notes.get(m.line) || []) if (n.includes('attachment')) lines.push('    ' + unit + ' ' + m.line + ': ' + n);
    lines.push(...notCarried(chosen, options), '');
    files.forEach((f, i) => {
      if (files.length > 1) lines.push('PART ' + (i + 1) + ' of ' + files.length + ': ' + f.name + ' (' + job.parts[i].length + ' messages)');
      if (f.verification) lines.push(...f.verification.lines, '');
    });
    return lines.join('\n').replace(/\n+$/, '') + '\n';
  }

  // ----------------------------------------------------------------------- verification

  function expectedSms(m, opts) {
    const o = m.o;
    const get = (k, fb) => (sval(o, k) !== null ? clean(sval(o, k), opts.nul) : fb);
    return [get('address', null), get('date', null), get('type', null), get('body', 'null'), get('read', 'null'),
      get('status', 'null'), get('date_sent', null), get('protocol', null), get('locked', null), get('subject', 'null'),
      get('service_center', 'null'), get('toa', 'null'), get('sc_toa', 'null'), subIdFor(o, opts.subId)];
  }

  const SMS_CHECKED = ['address', 'date', 'type', 'body', 'read', 'status', 'date_sent', 'protocol', 'locked',
    'subject', 'service_center', 'toa', 'sc_toa', 'sub_id'];

  function expectedMms(m, opts) {
    const o = m.o, val = (r, k) => (sval(r, k) !== null ? clean(sval(r, k), opts.nul) : 'null');
    return [m.dateMs.toString(), subIdFor(o, opts.subId),
      MMS_COPIED.map((k) => (sval(o, k) !== null ? clean(sval(o, k), opts.nul) : MMS_OMIT.has(k) ? null : 'null')),
      writtenParts(o, opts).map((p) => PART_ATTRS.map((k) => val(p, k))),
      mmsAddrRows(o).map((r) => ADDR_ATTRS.map((k) => val(r, k)))];
  }

  function sameValue(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
    }
    return a === b;
  }

  function sameBytes(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /** Parses each written element again with a real XML parser (the browser's DOMParser by
   *  default) and compares every field, and every attachment byte, with the source. */
  class Verifier {
    constructor(plan, options, parseXml, format) {
      this.plan = plan;
      this.opts = options;
      this.format = format || 'sie';  // other formats have no thread_id
      this.parse = parseXml || domParse;
      this.errors = [];
      this.n = { sms: 0, mms: 0 };
      this.matched = { sms: 0, mms: 0 };
      this.mismatched = [];
      this.attachments = 0;
      this.badDates = 0;
      this.badNames = 0;
      this.mmsProblems = 0;
      this.byThread = new Map();
    }

    check(xml, m, datas) {
      let el;
      try {
        el = this.parse(xml);
      } catch (e) {
        this.errors.push('XML is not well-formed (source line ' + m.line + '): ' + e.message);
        return;
      }
      this.n[m.kind] += 1;
      let same = el.tagName === m.kind;
      if (same && m.kind === 'sms') {
        same = el.children.length === 0 && sameValue(SMS_CHECKED.map((k) => el.getAttribute(k)), expectedSms(m, this.opts));
      } else if (same) {
        const kids = Array.from(el.children);
        if (kids.length !== 2 || kids[0].tagName !== 'parts' || kids[1].tagName !== 'addrs') {
          this.errors.push('an <mms> does not have exactly one <parts> and one <addrs> (source line ' + m.line + ')');
          same = false;
        } else {
          const partEls = Array.from(kids[0].children), addrEls = Array.from(kids[1].children);
          same = sameValue([el.getAttribute('date'), el.getAttribute('sub_id'), MMS_COPIED.map((k) => el.getAttribute(k)),
            partEls.map((p) => PART_ATTRS.map((k) => p.getAttribute(k))),
            addrEls.map((a) => ADDR_ATTRS.map((k) => a.getAttribute(k)))], expectedMms(m, this.opts));
          for (let i = 0; same && i < partEls.length; i++) {
            const got = partEls[i].getAttribute('data');
            if (datas[i] === null) {
              same = got === null;
            } else {
              try {
                same = got !== null && sameBytes(unbase64(got), datas[i]);
              } catch (e) {
                same = false;
              }
              if (same) this.attachments += 1;
            }
          }
        }
      }
      if (!same) {
        this.mismatched.push(m.line);
        return;
      }
      this.matched[m.kind] += 1;
      const date = el.getAttribute('date');
      if (isInt(date) && el.getAttribute('readable_date') !== readable(BigInt(date), this.opts.tz)) this.badDates += 1;
      if (!el.getAttribute('contact_name')) this.badNames += 1;
      // Android files each restored message under the participant set in its address attribute.
      const address = el.getAttribute('address') || '';
      let key;
      if (m.kind === 'sms') {
        key = setKey([addrKey(address)]);
      } else {
        const keys = new Set(address.split('~').map(addrKey));
        key = setKey(keys);
        const own = this.plan.others(m.o).map(addrKey);
        const hasOwner = Array.from(keys).some((k) => this.plan.owner.has(k));
        const hasOthers = Array.from(keys).some((k) => !this.plan.owner.has(k));
        if (!own.every((k) => keys.has(k)) || (hasOwner && hasOthers)) this.mmsProblems += 1;
      }
      const t = sval(m.o, 'thread_id');
      if (!this.byThread.has(t)) this.byThread.set(t, new Set());
      this.byThread.get(t).add(key);
    }

    finish(result) {
      const errors = this.errors.slice();
      const total = this.n.sms + this.n.mms;
      const expectSms = result.chosen.filter((m) => m.kind === 'sms').length;
      const expectMms = result.chosen.length - expectSms;
      if (total !== result.chosen.length) errors.push(result.chosen.length - total + ' message(s) could not be checked');
      if (this.mismatched.length) {
        errors.push(this.mismatched.length + ' message(s) do not match their source record exactly, e.g. source lines ' +
          this.mismatched.slice(0, 5).join(', '));
      }
      if (this.badDates) errors.push(this.badDates + ' readable_date value(s) do not match their date');
      if (this.badNames) errors.push(this.badNames + ' message(s) without contact_name');
      if (this.mmsProblems) errors.push(this.mmsProblems + ' MMS have an address attribute that leaves out a participant or includes the owner');
      const owners = new Map();
      for (const [t, keys] of this.byThread) {
        for (const k of keys) {
          if (!owners.has(k)) owners.set(k, new Set());
          owners.get(k).add(t);
        }
      }
      const show = (k) => { const s = JSON.parse(k); return s.length < 4 ? '[' + s.map(mask).join(', ') + ']' : '[' + s.length + ' people]'; };
      const repr = (t) => (t === null ? 'None' : "'" + t + "'");
      const lines = ["VERIFICATION (every element re-read with this browser's XML parser and compared field by field",
        '              with its source record)',
        '  well-formed XML:          ' + (errors.some((e) => e.includes('well-formed')) ? 'no' : 'yes'),
        '  messages in file:         ' + this.n.sms + ' SMS + ' + this.n.mms + ' MMS = ' + total + '; root count="' + result.chosen.length + '"',
        '  matched to source exactly: ' + this.matched.sms + ' SMS of ' + expectSms + ', ' + this.matched.mms + ' MMS of ' + expectMms +
          (result.options.sample ? ' (test sample)' : ''),
        '    compared: addresses, bodies/texts, dates (MMS seconds x 1000), type/msg_box, read,',
        '    seen, status, every MMS header, every part, every addr row',
        '  attachments checked:      ' + this.attachments + ' (decoded back from the XML and compared byte for byte)',
        '  conversations predicted after restore: ' + owners.size +
          (this.format === 'sie' ? ' (from ' + this.byThread.size + ' old thread_id values)' : '')];
      const split = Array.from(this.byThread.entries()).filter(([t, keys]) => keys.size > 1 && t !== null)
        .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
      for (const [t, keys] of split) {
        lines.push('    old thread ' + (t === null ? 'None' : t) + ' will appear as ' + keys.size + ' conversations: ' +
          Array.from(keys).map(show).join(' + '));
      }
      for (const [k, ts] of this.format === 'sie' ? owners : []) {
        if (ts.size > 1) {
          lines.push('    old threads [' + Array.from(ts).sort((a, b) => (String(a) < String(b) ? -1 : 1)).map(repr).join(', ') +
            '] will share one conversation [' + JSON.parse(k).map(mask).join(', ') + ']');
        }
      }
      lines.push('  result: ' + (errors.length ? 'FAILED' : 'PASSED'));
      for (const e of errors) lines.push('    ! ' + e);
      return { ok: !errors.length, errors, lines, conversations: owners.size, oldConversations: this.byThread.size,
        split: split.map(([t, keys]) => [t, keys.size]) };
    }
  }

  /** Without a browser (under Node), elements are re-read with this file's XmlReader. */
  function readerParse(xml) {
    const top = { children: [] }, stack = [top];
    const reader = new XmlReader((name, attrs) => {
      const map = new Map(attrs);
      const el = { tagName: name, children: [], getAttribute: (k) => (map.has(k) ? map.get(k) : null) };
      stack[stack.length - 1].children.push(el);
      stack.push(el);
    }, () => { stack.pop(); });
    reader.feed(xml);
    reader.finish();
    if (top.children.length !== 1 || stack.length !== 1) throw new Error('not exactly one element');
    return top.children[0];
  }

  function domParse(xml) {
    if (typeof DOMParser === 'undefined') return readerParse(xml);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const err = doc.getElementsByTagName('parsererror');
    if (err.length) throw new Error((err[0].textContent || 'parse error').trim().split('\n')[0]);
    return doc.documentElement;
  }

  /** The XML prolog and root element must also be well-formed on their own. */
  function checkProlog(parseXml, options) {
    (parseXml || domParse)(header(1, options, new Date()) + '<sms address="1" />\n</smses>\n');
  }

  const api = {
    VERSION, APP, TARGETS, TARGET_NAMES, Msg, Plan, Converter, Verifier, parseNdjson, sourceFromZip, sourceFromFiles,
    sourceFromXmlFile, load, prepare, writePart, choose, splitMessages, chatKey, estimateTotal, manifest, report, summarize, notCarried,
    header, fileStamp, localTimeZone, checkTimeZone, checkProlog, readable, addrKey, mask, esc, base64, unbase64, sval,
    mmsParts, partFile, utc, XmlReader, xmlRecords, AttachmentStore,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SieToSbr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
