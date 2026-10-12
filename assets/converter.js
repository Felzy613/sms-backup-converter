/* SMS Import / Export -> SMS Backup & Restore: the conversion engine.
 *
 * A line-for-line port of cli/sie_to_sbr.py: the same decisions and byte-identical XML
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
      if (!isDict(o)) bad.push([line, 'line is not a JSON object']);
      else if (pick(o, K_PARTS) !== null || hasOwn(o, 'msg_box') || hasOwn(o, 'm_type')) msgs.push(new Msg(line, 'mms', o));
      else if (hasOwn(o, 'body') || hasOwn(o, 'address')) msgs.push(new Msg(line, 'sms', o));
      else bad.push([line, 'neither an SMS nor an MMS record']);
    }
    return { msgs, bad, blank };
  }

  /** A source backed by a ZIP archive opened with SieZip.openZip. */
  function sourceFromZip(zip, label) {
    const found = zip.names.filter((n) => n.split('/').pop() === 'messages.ndjson');
    if (!found.length) {
      throw new Error('There is no messages.ndjson in this ZIP file. Choose the messages-YYYY-MM-DD.zip ' +
        'that SMS Import / Export created.');
    }
    const ndjson = found.reduce((a, b) => (b.length < a.length ? b : a));
    const prefix = ndjson.slice(0, -'messages.ndjson'.length) + 'data/';
    const members = new Map();
    for (const n of zip.names) if (n.startsWith(prefix) && !n.endsWith('/')) members.set(n.slice(prefix.length), n);
    return {
      kind: 'zip',
      label,
      names: new Set(members.keys()),
      readNdjson: () => zip.read(ndjson),
      readPart: (name) => zip.read(members.get(name)),
      partSize: (name) => zip.entries.get(members.get(name)).usize,
    };
  }

  /** A source backed by an extracted folder: files = [{path, size, read() -> Uint8Array}]. */
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
      kind: 'folder',
      label,
      names: new Set(partsByName.keys()),
      readNdjson: () => nd.read(),
      readPart: (name) => partsByName.get(name).read(),
      partSize: (name) => partsByName.get(name).size,
    };
  }

  async function load(src) {
    return parseNdjson(await src.readNdjson());
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
  function pickSample(msgs, plan) {
    const byThread = new Map();
    for (const m of msgs) {
      const t = sval(m.o, 'thread_id');
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
      if (t === null || !sms.length || !mms.length || mms.some(group)) continue;
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
      for (const p of mmsParts(o)) {
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
      '<!--Converted from an SMS Import / Export backup by ' + APP + ' ' + VERSION + ' on ' + localStamp(now) +
      '. readable_date values are in ' + tzLabel(options.tz) + '.-->\n' +
      '<?xml-stylesheet type="text/xsl" href="sms.xsl"?>\n' +
      '<smses count="' + count + '" backup_set="' + uuid4() + '" backup_date="' + now.getTime() + '" type="full">\n';
  }

  /** Convert and write. options: {sample, subId: 'unknown'|'keep'|'<n>', tz, nul: 'strip'|'replace', owner}.
   *  sink: {write(string) -> Promise, close() -> Promise}. verifier: optional Verifier. */
  async function convert({ src, loaded, plan, options, sink, onProgress, verifier, signal, now }) {
    now = now || new Date();
    plan = plan || new Plan(loaded.msgs, options.owner || null);
    const conv = new Converter(src, plan, options);
    const problems = [], ok = [];
    for (const m of loaded.msgs) {
      const why = plan.problem(m);
      if (why) problems.push([m, why]);
      else ok.push(m);
    }
    const chosen = options.sample ? pickSample(ok, plan) : ok;
    await sink.write(header(chosen.length, options, now));
    for (let i = 0; i < chosen.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const m = chosen[i];
      let xml, datas = null;
      if (m.kind === 'sms') xml = conv.sms(m);
      else ({ xml, datas } = await conv.mms(m));
      if (verifier) verifier.check(xml, m, datas);
      await sink.write(xml);
      if (onProgress && (m.kind === 'mms' || i % 250 === 0)) await onProgress(i + 1, chosen.length);
    }
    await sink.write('</smses>\n');
    await sink.close();
    if (onProgress) await onProgress(chosen.length, chosen.length);
    const result = { src, loaded, plan, conv, problems, ok, chosen, options, now };
    if (verifier) result.verification = verifier.finish(result);
    return result;
  }

  // ----------------------------------------------------------------------- manifest and report

  function csvField(v) {
    if (v === null || v === undefined) return '';
    v = String(v);
    return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  /** One row per written message, identical to the Python version's .manifest.csv. */
  function manifest(result) {
    const { chosen, plan, conv, options } = result;
    const rows = [['xml_index', 'kind', 'direction', 'source_line', 'source_id', 'source_thread_id',
      'source_sub_id', 'written_sub_id', 'date_ms', 'date_utc', 'address_written', 'parts',
      'attachments', 'notes']];
    chosen.forEach((m, i) => {
      const o = m.o;
      const mms = m.kind === 'mms';
      rows.push([i + 1, m.kind, m.direction, m.line, sval(o, '_id'), sval(o, 'thread_id'), sval(o, 'sub_id'),
        subIdFor(o, options.subId), m.dateMs.toString(), utc(m.dateMs),
        mms ? plan.addressList(m).join('~') : sval(o, 'address'),
        mms ? mmsParts(o).length : '', mms ? mmsParts(o).filter((p) => partFile(p)).length : '',
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
      conversations: new Set(msgs.map((m) => sval(m.o, 'thread_id'))).size,
      owner: Array.from(plan.owner).sort().map(mask), ownerHow: plan.ownerHow,
      first: min, last: max,
      problems: msgs.filter((m) => plan.problem(m)).map((m) => [m.line, m.kind, plan.problem(m)]),
      text: [
        'SOURCE',
        '  name:              ' + src.label + ' (' + src.kind + ')',
        '  format:            SMS Import / Export (com.github.tmo1.sms_ie) export: messages.ndjson + data/',
        '  records:           ' + (msgs.length + bad.length + blank) + ' lines (' + blank + ' blank, ' + bad.length + ' unreadable)',
        '  SMS:               ' + sms.length + ' (' + counted(sms, (m) => m.direction) + ')',
        '  MMS:               ' + mms.length + ' (' + counted(mms, (m) => m.direction) + ')',
        '  MMS parts:         ' + allParts.length + ' (' + counted(allParts, (p) => (sval(p, 'ct') === 'application/smil'
          ? 'SMIL' : partFile(p) ? 'attachment' : 'text')) + ')',
        '  attachment files:  ' + refs.length + ' referenced, ' + found.length + ' present, ' + (refs.length - found.length) +
          ' missing, ' + empty + ' empty (0 bytes); ' + Array.from(src.names).filter((n) => !refSet.has(n)).length +
          ' file(s) in data/ not referenced by any part',
        '  conversations:     ' + new Set(msgs.map((m) => sval(m.o, 'thread_id'))).size + ' thread_id values',
        '  owner number:      ' + (Array.from(plan.owner).sort().map(mask).join(', ') || 'unknown') + ' (from ' + plan.ownerHow + ')',
        dates.length ? '  dates:             ' + utc(min, false) + ' .. ' + utc(max, false) : '  dates:             none',
        '  SIM sub_id values: ' + counted(msgs, (m) => String(sval(m.o, 'sub_id') ?? 'None')),
      ],
    };
  }

  function notCarried(msgs, subPolicy) {
    const knownSms = new Set(SMS_ORDER.concat(K_NAME));
    const knownMms = new Set(MMS_ORDER.concat(K_PARTS, K_SENDER, K_RECIPS, K_NAME));
    const c = new Map();
    const add = (k) => c.set(k, (c.get(k) || 0) + 1);
    for (const m of msgs) {
      if (m.kind === 'sms') {
        for (const k of Object.keys(m.o)) if (!knownSms.has(k)) add('sms.' + k);
      } else {
        for (const k of Object.keys(m.o)) if (!knownMms.has(k)) add('mms.' + k);
        for (const p of mmsParts(m.o)) for (const k of Object.keys(p)) if (!PART_ATTRS.includes(k) && k !== '_data') add('part.' + k);
        for (const r of mmsAddrRows(m.o)) for (const k of Object.keys(r)) if (!ADDR_ATTRS.includes(k) && !K_NAME.includes(k)) add('addr.' + k);
      }
      if (subPolicy !== 'keep' && sval(m.o, 'sub_id') !== null) add(m.kind + '.sub_id (old phone value)');
    }
    const lines = ["  source fields not stored in the XML (no matching field in SMS Backup & Restore's format,",
      '  or specific to the old phone; ids and sub_id are kept in the manifest):'];
    const keys = Array.from(c.keys()).sort();
    for (const k of keys) lines.push('    ' + k.padEnd(34) + ' ' + c.get(k));
    if (!keys.length) lines.push('    none');
    return lines;
  }

  /** The conversion report (.report.txt). bytes: the size of the written XML file. */
  function report(result, fileName, bytes) {
    const { src, loaded, plan, conv, problems, chosen, options } = result;
    const s = conv.stats;
    const lines = summarize(src, loaded, plan).text.concat(['', 'CONVERSION',
      '  output:            ' + fileName + ' (' + bytes.toLocaleString('en-US') + ' bytes)',
      '  mode:              ' + (options.sample ? 'test sample' : 'all messages'),
      '  written:           ' + chosen.filter((m) => m.kind === 'sms').length + ' SMS + ' +
        chosen.filter((m) => m.kind === 'mms').length + ' MMS = ' + chosen.length + ' messages (count="' + chosen.length + '")',
      '  attachments:       ' + (s.attachments - s.attachments_missing) + ' written (' + s.attachment_bytes.toLocaleString('en-US') +
        ' bytes), ' + s.attachments_empty + ' empty in the export, ' + s.attachments_missing + ' missing from the export',
      '  not convertible:   ' + (problems.length + loaded.bad.length) + ' record(s)' + (problems.length || loaded.bad.length ? '' : ' (none)')]);
    for (const [m, why] of problems) lines.push('    line ' + m.line + ' (' + m.kind + '): ' + why);
    for (const [line, why] of loaded.bad) lines.push('    line ' + line + ': ' + why);
    lines.push('  sub_id (SIM):      ' + (options.subId === 'unknown'
      ? 'written as -1 ("SIM unknown") for every message; the old phone\'s values are in the manifest'
      : options.subId === 'keep' ? 'the old phone\'s values written unchanged' : 'written as ' + options.subId + ' for every message'));
    lines.push('  text changes:      ' + conv.changes.length + ' field(s) had characters XML cannot store (' +
      (options.nul === 'strip' ? 'removed' : 'replaced by U+FFFD') + ')' + (conv.changes.length ? '' : ' - none'));
    for (const [line, kind, field, n, chars] of conv.changes) lines.push('    line ' + line + ' (' + kind + ' ' + field + '): ' + n + ' x ' + chars.join('/'));
    lines.push('  MMS whose "address" comes from their conversation (headers list fewer people): ' + s.mms_address_from_conversation);
    for (const m of chosen) {
      if ((conv.notes.get(m.line) || []).some((n) => n.startsWith('MMS headers'))) lines.push('    line ' + m.line + ' (thread ' + sval(m.o, 'thread_id') + ')');
    }
    for (const m of chosen) for (const n of conv.notes.get(m.line) || []) if (n.includes('attachment')) lines.push('    line ' + m.line + ': ' + n);
    return lines.concat(notCarried(chosen, options.subId), [''], result.verification ? result.verification.lines : []).join('\n') + '\n';
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
      mmsParts(o).map((p) => PART_ATTRS.map((k) => val(p, k))),
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
    constructor(plan, options, parseXml) {
      this.plan = plan;
      this.opts = options;
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
        '  conversations predicted after restore: ' + owners.size + ' (from ' + this.byThread.size + ' old thread_id values)'];
      const split = Array.from(this.byThread.entries()).filter(([, keys]) => keys.size > 1)
        .sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1));
      for (const [t, keys] of split) {
        lines.push('    old thread ' + (t === null ? 'None' : t) + ' will appear as ' + keys.size + ' conversations: ' +
          Array.from(keys).map(show).join(' + '));
      }
      for (const [k, ts] of owners) {
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

  function domParse(xml) {
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
    VERSION, APP, Msg, Plan, Converter, Verifier, parseNdjson, sourceFromZip, sourceFromFiles, load, convert,
    pickSample, manifest, report, summarize, notCarried, header, fileStamp, localTimeZone, checkTimeZone,
    checkProlog, readable, addrKey, mask, esc, base64, unbase64, sval, mmsParts, partFile, utc,
  };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SieToSbr = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
