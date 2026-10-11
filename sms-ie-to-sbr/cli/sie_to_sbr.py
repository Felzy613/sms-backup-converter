#!/usr/bin/env python3
"""
sie_to_sbr.py - convert an "SMS Import / Export" export into an XML backup that
"SMS Backup & Restore" (SyncTech) can restore, then verify the result.

SOURCE  The export written by SMS Import / Export (com.github.tmo1.sms_ie, v2 or
        later): either the original messages-YYYY-MM-DD.zip or its extracted folder.
          messages.ndjson  one JSON object per line: SMS rows (the columns of
                           Android's content://sms) and MMS rows (content://mms)
                           plus the keys the app adds: __display_name,
                           __sender_address, __recipient_addresses, __parts
          data/PART_*      MMS attachment files, matched to a part by the file
                           name at the end of the part's "_data" path
TARGET  The XML format restored by SMS Backup & Restore:
        https://www.synctech.com.au/sms-backup-restore/fields-in-xml-backup-files/

The source is only ever opened for reading. Standard library only (Python 3.8+).
The browser app (index.html / assets/converter.js) produces byte-identical XML;
tests/test_all.py checks that.

  python3 sie_to_sbr.py analyze SOURCE
  python3 sie_to_sbr.py convert SOURCE sms-20261005120000.xml
  python3 sie_to_sbr.py convert SOURCE sms-test-20261005120000.xml --sample
  python3 sie_to_sbr.py verify  SOURCE sms-20261005120000.xml

`convert` always runs `verify` on the file it wrote, and also writes
<output>.manifest.csv (one row per written message, with its source line, old
row id, thread id and SIM id) and <output>.report.txt.
"""

import argparse
import base64
import collections
import csv
import datetime as dt
import hashlib
import json
import os
import re
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET

VERSION = '1.0.0'
INSERT_TOKEN = 'insert-address-token'  # Android's placeholder for the phone's own number
UNKNOWN_SUB_ID = '-1'                  # SubscriptionManager.INVALID_SUBSCRIPTION_ID

# Keys added by SMS Import / Export (v2 prefixes them with "__", v1 did not).
K_PARTS = ('__parts', 'parts')
K_SENDER = ('__sender_address', 'sender_address')
K_RECIPS = ('__recipient_addresses', 'recipient_addresses')
K_NAME = ('__display_name', 'display_name')

# Characters XML 1.0 cannot contain at all, not even as &#..; references.
XML_ILLEGAL = re.compile('[\x00-\x08\x0b\x0c\x0e-\x1f￾￿\ud800-\udfff]')
ESCAPES = {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
           '\n': '&#10;', '\r': '&#13;', '\t': '&#9;'}
ESCAPE_RE = re.compile('[&<>"\n\r\t]')
MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split()

# Attributes in the order SMS Backup & Restore writes them. When the source has no
# value an attribute gets the literal "null" (how SMS Backup & Restore itself writes
# a NULL column), except the ones listed in *_OMIT, which SyncTech's schema marks
# optional and which are left out instead. date, address, sub_id, readable_date and
# contact_name are computed.
SMS_ORDER = ['protocol', 'address', 'date', 'type', 'subject', 'body', 'toa', 'sc_toa',
             'service_center', 'read', 'status', 'locked', 'date_sent', 'sub_id',
             'readable_date', 'contact_name']
SMS_OMIT = {'protocol', 'locked', 'date_sent'}
MMS_ORDER = ['date', 'rr', 'sub', 'ct_t', 'read_status', 'seen', 'msg_box', 'address',
             'sub_cs', 'resp_st', 'retr_st', 'd_tm', 'text_only', 'exp', 'locked', 'm_id',
             'st', 'retr_txt_cs', 'retr_txt', 'date_sent', 'read', 'm_size', 'rpt_a',
             'ct_cls', 'pri', 'sub_id', 'tr_id', 'resp_txt', 'ct_l', 'm_cls', 'd_rpt', 'v',
             'm_type', 'readable_date', 'contact_name']
MMS_OMIT = {'text_only'}
COMPUTED = {'date', 'address', 'sub_id', 'readable_date', 'contact_name'}
MMS_COPIED = [k for k in MMS_ORDER if k not in COMPUTED]
PART_ATTRS = ['seq', 'ct', 'name', 'chset', 'cd', 'fn', 'cid', 'cl', 'ctt_s', 'ctt_t', 'text']
ADDR_ATTRS = ['address', 'type', 'charset']

SMS_TYPES = {'1': 'received', '2': 'sent', '3': 'draft', '4': 'outbox', '5': 'failed', '6': 'queued'}
MMS_BOXES = {'1': 'received', '2': 'sent', '3': 'draft', '4': 'outbox'}


# ----------------------------------------------------------------------------- source

class Source:
    """Read-only access to an SMS Import / Export export (zip file or extracted folder)."""

    def __init__(self, path):
        self.path = os.path.abspath(path)
        self.zip = None
        if os.path.isdir(self.path):
            self.kind = 'folder'
            self.ndjson = os.path.join(self.path, 'messages.ndjson')
            if not os.path.isfile(self.ndjson):
                sys.exit('error: %s not found' % self.ndjson)
            self.data_dir = os.path.join(self.path, 'data')
            self.names = set(os.listdir(self.data_dir)) if os.path.isdir(self.data_dir) else set()
        elif zipfile.is_zipfile(self.path):
            self.kind = 'zip'
            self.zip = zipfile.ZipFile(self.path)
            members = self.zip.namelist()
            found = [n for n in members if n.rsplit('/', 1)[-1] == 'messages.ndjson']
            if not found:
                sys.exit('error: no messages.ndjson inside %s' % self.path)
            self.ndjson = min(found, key=len)
            prefix = self.ndjson[:-len('messages.ndjson')] + 'data/'
            self.members = {n[len(prefix):]: n for n in members
                            if n.startswith(prefix) and not n.endswith('/')}
            self.names = set(self.members)
        else:
            sys.exit('error: %s is neither a folder nor a zip file' % path)

    def lines(self):
        f = self.zip.open(self.ndjson) if self.zip else open(self.ndjson, 'rb')
        with f:
            for number, raw in enumerate(f, 1):
                yield number, raw

    def read_part(self, name):
        if self.zip:
            with self.zip.open(self.members[name]) as f:
                return f.read()
        with open(os.path.join(self.data_dir, name), 'rb') as f:
            return f.read()


class Msg:
    """One source record: its line number in messages.ndjson, 'sms' or 'mms', the JSON object."""

    __slots__ = ('line', 'kind', 'o')

    def __init__(self, line, kind, o):
        self.line, self.kind, self.o = line, kind, o

    @property
    def date_ms(self):
        d = sval(self.o, 'date')
        if not is_int(d):
            return None
        v = int(d)
        if self.kind == 'mms' and v < 10 ** 11:  # Android stores MMS dates in seconds
            v *= 1000
        return v

    @property
    def direction(self):
        if self.kind == 'sms':
            return SMS_TYPES.get(sval(self.o, 'type'), 'type ' + str(sval(self.o, 'type')))
        return MMS_BOXES.get(sval(self.o, 'msg_box'), 'msg_box ' + str(sval(self.o, 'msg_box')))


def load(src):
    msgs, bad, blank = [], [], 0
    for number, raw in src.lines():
        if not raw.strip():
            blank += 1
            continue
        try:
            o = json.loads(raw.decode('utf-8'))
        except (UnicodeDecodeError, ValueError) as e:
            bad.append((number, 'unreadable line: %s' % e))
            continue
        if not isinstance(o, dict):
            bad.append((number, 'line is not a JSON object'))
        elif pick(o, K_PARTS) is not None or 'msg_box' in o or 'm_type' in o:
            msgs.append(Msg(number, 'mms', o))
        elif 'body' in o or 'address' in o:
            msgs.append(Msg(number, 'sms', o))
        else:
            bad.append((number, 'neither an SMS nor an MMS record'))
    return msgs, bad, blank


# ----------------------------------------------------------------------------- helpers

def pick(o, keys):
    for k in keys:
        if isinstance(o, dict) and o.get(k) is not None:
            return o[k]
    return None


def sval(o, key):
    """A column value as a string, or None when the source has no value."""
    v = o.get(key) if isinstance(o, dict) else None
    if v is None or isinstance(v, (dict, list)):
        return None
    if isinstance(v, bool):
        return '1' if v else '0'
    return v if isinstance(v, str) else str(v)


def is_int(s):
    return s is not None and re.fullmatch(r'-?[0-9]+', s) is not None


def mms_parts(o):
    p = pick(o, K_PARTS)
    return [x for x in p if isinstance(x, dict)] if isinstance(p, list) else []


def mms_addr_rows(o):
    """The MMS's address rows (From/To/Cc/Bcc) in their original order in the phone's table."""
    rows = []
    s = pick(o, K_SENDER)
    if isinstance(s, dict):
        rows.append(s)
    r = pick(o, K_RECIPS)
    if isinstance(r, list):
        rows += [x for x in r if isinstance(x, dict)]
    if rows and all(is_int(sval(x, '_id')) for x in rows):
        rows.sort(key=lambda x: int(sval(x, '_id')))
    return rows


def part_file(p):
    d = sval(p, '_data')
    return d.replace('\\', '/').rsplit('/', 1)[-1] if d else None


def digits(s):
    return re.sub(r'[^0-9]', '', s or '')


def addr_key(a):
    """Loose identity of an address, close to Android's PHONE_NUMBERS_EQUAL matching:
    the last 10 digits of a phone number; short codes, names and e-mail as written."""
    a = (a or '').strip()
    tokens = a.split()
    if len(tokens) > 1 and all(len(digits(t)) >= 7 for t in tokens):
        return 'multi:' + ','.join(sorted({addr_key(t) for t in tokens}))
    d = digits(a)
    if len(d) >= 7 and not re.search(r'[A-Za-z@]', a):
        return d[-10:]
    return a.lower()


def mask(a):
    d = digits(a)
    if (a or '').startswith('multi:'):
        return '[%d numbers]' % (a.count(',') + 1)
    return '…' + d[-4:] if len(d) >= 7 else a


def esc(s):
    return ESCAPE_RE.sub(lambda m: ESCAPES[m.group()], s)


def readable(ms, tz):
    """The date the way SMS Backup & Restore shows it, e.g. 'Sep 30, 2010 8:34:28 AM'."""
    try:
        t = (dt.datetime.fromtimestamp(ms // 1000, tz) if tz
             else dt.datetime.fromtimestamp(ms // 1000).astimezone())
    except (OverflowError, ValueError, OSError):
        return None
    return '%s %d, %d %d:%02d:%02d %s' % (MONTHS[t.month - 1], t.day, t.year, t.hour % 12 or 12,
                                          t.minute, t.second, 'AM' if t.hour < 12 else 'PM')


def utc(ms, fmt='%Y-%m-%d %H:%M:%S'):
    try:
        return dt.datetime.fromtimestamp(ms // 1000, dt.timezone.utc).strftime(fmt)
    except (OverflowError, ValueError, OSError):
        return ''


def get_tz(name):
    if not name:
        return None
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception as e:
        sys.exit('error: unknown time zone %r (%s)' % (name, e))


def tz_label(name):
    if name:
        return name
    real = os.path.realpath('/etc/localtime')
    if 'zoneinfo/' in real:
        return real.split('zoneinfo/', 1)[1] + ' (this computer\'s time zone)'
    return dt.datetime.now().astimezone().tzname() + ' (this computer\'s time zone)'


def sub_id_for(o, policy):
    if policy == 'keep':
        return sval(o, 'sub_id')
    if policy == 'unknown':
        return UNKNOWN_SUB_ID
    return policy


def clean(s, mode):
    return XML_ILLEGAL.sub('' if mode == 'strip' else '�', s) if s else s


# ----------------------------------------------------------------------------- planning

class Plan:
    """Decisions that need the whole export: the owner's number and each MMS's conversation."""

    def __init__(self, msgs, owner_override=None):
        self.msgs = msgs
        self.owner, self.owner_how = self.detect_owner(owner_override)
        self.names = {}
        for m in msgs:
            rows = [m.o] if m.kind == 'sms' else mms_addr_rows(m.o)
            for r in rows:
                name, a = pick(r, K_NAME), sval(r, 'address')
                if isinstance(name, str) and name and a:
                    self.names.setdefault(addr_key(a), name)
        self.thread_lists = self.conversation_addresses()

    def detect_owner(self, override):
        if override:
            return {addr_key(x) for x in override.split(',') if x.strip()}, 'set manually'
        senders = collections.Counter()
        for m in self.msgs:
            if m.kind == 'mms' and sval(m.o, 'msg_box') == '2':
                for r in mms_addr_rows(m.o):
                    a = sval(r, 'address')
                    if sval(r, 'type') == '137' and a and a != INSERT_TOKEN:
                        senders[addr_key(a)] += 1
        if senders:
            return set(senders), 'the sender ("From") of the sent MMS'
        received, n = collections.Counter(), 0
        for m in self.msgs:
            if m.kind == 'mms' and sval(m.o, 'msg_box') == '1':
                n += 1
                for k in {addr_key(sval(r, 'address')) for r in mms_addr_rows(m.o) if sval(r, 'type') != '137'}:
                    received[k] += 1
        if received:
            ranked = received.most_common(2)
            k, c = ranked[0]
            if c >= 0.5 * n and (len(ranked) == 1 or ranked[1][1] < c):  # a tie is ambiguous
                return {k}, 'the recipient of most received MMS'
        return set(), 'not found (set it manually)'

    def others(self, o):
        """Everyone in an MMS's From/To/Cc/Bcc headers except the phone's owner, as written."""
        out, seen = [], set()
        for r in mms_addr_rows(o):
            a = sval(r, 'address')
            if not a or a == INSERT_TOKEN:
                continue
            k = addr_key(a)
            if k not in self.owner and k not in seen:
                seen.add(k)
                out.append(a)
        return out

    @staticmethod
    def own_address(o):
        for r in mms_addr_rows(o):
            a = sval(r, 'address')
            if a and a != INSERT_TOKEN:
                return [a]
        return []

    def conversation_addresses(self):
        """For each old conversation (thread_id): the participants most of its MMS list.
        Every MMS of the conversation gets this list as its "address" attribute, which is
        what Android uses on restore to put the message into a conversation."""
        by_thread = collections.defaultdict(list)
        for m in self.msgs:
            if m.kind == 'mms' and sval(m.o, 'thread_id') is not None:
                by_thread[sval(m.o, 'thread_id')].append(m)
        lists = {}
        for t, ms in by_thread.items():
            keyed = [(frozenset(addr_key(a) for a in self.others(m.o)), m) for m in ms]
            counts = collections.Counter(k for k, _ in keyed)
            best = max(counts, key=lambda k: (counts[k], len(k), sorted(k)))
            rep = min((m for k, m in keyed if k == best), key=lambda m: (m.date_ms or 0, m.line))
            lists[t] = self.others(rep.o) or self.own_address(rep.o)
        return lists

    def address_list(self, m):
        t = sval(m.o, 'thread_id')
        if t in self.thread_lists:
            return self.thread_lists[t]
        return self.others(m.o) or self.own_address(m.o)

    def contact_names(self, m, addresses):
        own = {}
        for r in mms_addr_rows(m.o):
            name, a = pick(r, K_NAME), sval(r, 'address')
            if isinstance(name, str) and name and a:
                own.setdefault(addr_key(a), name)
        return ', '.join(own.get(addr_key(a)) or self.names.get(addr_key(a)) or '(Unknown)' for a in addresses)

    def problem(self, m):
        """Why a record cannot be written as a restorable message, or None."""
        o = m.o
        if m.kind == 'sms':
            for k in ('address', 'date', 'type'):
                if not sval(o, k):
                    return 'no "%s" value' % k
            if not is_int(sval(o, 'date')):
                return '"date" is not a number'
            return None
        if not is_int(sval(o, 'date')):
            return 'no numeric "date" value'
        if not sval(o, 'msg_box'):
            return 'no "msg_box" value'
        if not self.address_list(m):
            return 'no sender or recipient address'
        return None


def pick_sample(msgs, plan):
    """A small, representative test set: one one-to-one conversation (SMS both ways, MMS
    with attachments both ways, a text-only MMS, SMS with line breaks / emoji / XML
    special characters) and the largest group conversation (received with and without
    attachments, sent)."""
    by_thread = collections.defaultdict(list)
    for m in msgs:
        by_thread[sval(m.o, 'thread_id')].append(m)

    def media(m):
        return m.kind == 'mms' and any(part_file(p) for p in mms_parts(m.o))

    def group(m):
        return m.kind == 'mms' and len(plan.address_list(m)) > 1

    def newest(ms):
        return sorted(ms, key=lambda m: (m.date_ms or 0), reverse=True)

    chosen, best = [], None
    for t, ms in by_thread.items():
        sms = [m for m in ms if m.kind == 'sms']
        mms = [m for m in ms if m.kind == 'mms']
        if t is None or not sms or not mms or any(group(m) for m in mms):
            continue
        score = (sum(any(media(m) and sval(m.o, 'msg_box') == b for m in mms) for b in '12'),
                 len({sval(m.o, 'type') for m in sms}), len(ms))
        if best is None or score > best[0]:
            best = (score, t)
    if best:
        ms = newest(by_thread[best[1]])
        sms = [m for m in ms if m.kind == 'sms']
        picked = sms[:10]
        for typ in '12':
            if not any(sval(m.o, 'type') == typ for m in picked):
                picked += [m for m in sms if sval(m.o, 'type') == typ][:1]
        picked += [m for m in sms if m not in picked and
                   re.search('[\n&<>"]|[^\u0000-￿]', sval(m.o, 'body') or '')][:3]
        for box in '12':
            picked += [m for m in ms if media(m) and sval(m.o, 'msg_box') == box][:1]
        picked += [m for m in ms if m.kind == 'mms' and not media(m)][:1]
        chosen += picked
    groups = [(len(ms), t) for t, ms in by_thread.items() if t is not None and any(group(m) for m in ms)]
    if groups:
        ms = newest([m for m in by_thread[max(groups)[1]] if m.kind == 'mms'])
        chosen += [m for m in ms if media(m) and sval(m.o, 'msg_box') == '1'][:1]
        chosen += [m for m in ms if not media(m) and sval(m.o, 'msg_box') == '1'][:2]
        chosen += [m for m in ms if sval(m.o, 'msg_box') == '2'][:1]
    unique = {m.line: m for m in chosen}
    return [unique[k] for k in sorted(unique)]


# ----------------------------------------------------------------------------- convert

class Converter:
    def __init__(self, src, plan, args):
        self.src, self.plan, self.args = src, plan, args
        self.tz = get_tz(args.tz)
        self.changes = []        # (line, kind, field, characters) for text XML cannot hold
        self.notes = collections.defaultdict(list)  # line -> notes for manifest/report
        self.stats = collections.Counter()

    def text(self, value, m, field):
        if value and XML_ILLEGAL.search(value):
            chars = sorted({'U+%04X' % ord(c) for c in XML_ILLEGAL.findall(value)})
            n = len(XML_ILLEGAL.findall(value))
            self.changes.append((m.line, m.kind, field, n, chars))
            self.notes[m.line].append('%d character(s) %s %s from %s' % (
                n, '/'.join(chars), 'removed' if self.args.nul == 'strip' else 'replaced by U+FFFD', field))
            value = clean(value, self.args.nul)
        return esc(value)

    def tag(self, indent, name, attrs, m, prefix='', end=' />'):
        return '%s<%s%s%s\n' % (indent, name, ''.join(
            ' %s="%s"' % (k, self.text(v, m, prefix + k)) for k, v in attrs), end)

    def sms(self, m):
        o, attrs = m.o, []
        for k in SMS_ORDER:
            if k == 'sub_id':
                v = sub_id_for(o, self.args.sub_id)
            elif k == 'readable_date':
                v = readable(m.date_ms, self.tz)
            elif k == 'contact_name':
                name = pick(o, K_NAME)
                v = name if isinstance(name, str) and name else '(Unknown)'
            else:
                v = sval(o, k)
                if v is None and k not in SMS_OMIT:
                    v = 'null'
            if v is not None:
                attrs.append((k, v))
        return self.tag('  ', 'sms', attrs, m)

    def mms(self, m):
        o, attrs = m.o, []
        addresses = self.plan.address_list(m)
        own = frozenset(addr_key(a) for a in self.plan.others(o))
        if own != frozenset(addr_key(a) for a in addresses) and own:
            self.notes[m.line].append('MMS headers list %d other participant(s); "address" uses the %d of '
                                      'its conversation so it stays in that conversation' % (len(own), len(addresses)))
            self.stats['mms_address_from_conversation'] += 1
        for k in MMS_ORDER:
            if k == 'date':
                v = str(m.date_ms)
            elif k == 'address':
                v = '~'.join(addresses)
            elif k == 'sub_id':
                v = sub_id_for(o, self.args.sub_id)
            elif k == 'readable_date':
                v = readable(m.date_ms, self.tz)
            elif k == 'contact_name':
                v = self.plan.contact_names(m, addresses)
            else:
                v = sval(o, k)
                if v is None and k not in MMS_OMIT:
                    v = 'null'
            if v is not None:
                attrs.append((k, v))
        out = [self.tag('  ', 'mms', attrs, m, end='>'), '    <parts>\n']
        for p in mms_parts(o):
            line = self.tag('      ', 'part', [(k, sval(p, k) if sval(p, k) is not None else 'null')
                                               for k in PART_ATTRS], m, 'part.', end='')
            name = part_file(p)
            if name:
                self.stats['attachments'] += 1
                if name in self.src.names:
                    data = self.src.read_part(name)
                    line = line[:-1] + ' data="%s"\n' % base64.b64encode(data).decode('ascii')
                    self.stats['attachment_bytes'] += len(data)
                    if not data:
                        self.stats['attachments_empty'] += 1
                        self.notes[m.line].append('attachment %s (%s) is an empty (0-byte) file in the '
                                                  'export' % (name, sval(p, 'ct')))
                else:
                    self.stats['attachments_missing'] += 1
                    self.notes[m.line].append('attachment file %s (%s) is not in the export; part written '
                                              'without data' % (name, sval(p, 'ct')))
            out.append(line[:-1] + ' />\n')
        out.append('    </parts>\n    <addrs>\n')
        for r in mms_addr_rows(o):
            out.append(self.tag('      ', 'addr', [(k, sval(r, k) if sval(r, k) is not None else 'null')
                                                   for k in ADDR_ATTRS], m, 'addr.'))
        out.append('    </addrs>\n  </mms>\n')
        return ''.join(out)


def guard_output(src, out, force):
    out = os.path.abspath(out)
    if out == src.path or (src.kind == 'folder' and (
            out == src.ndjson or out.startswith(os.path.join(src.path, 'data') + os.sep))):
        sys.exit('error: refusing to write into the source export')
    if not out.lower().endswith('.xml'):
        sys.exit('error: the output file name must end in .xml (SMS Backup & Restore lists sms-*.xml)')
    if os.path.exists(out) and not force:
        sys.exit('error: %s already exists (use --force to replace it)' % out)


def cmd_convert(args):
    src = Source(args.source)
    guard_output(src, args.output, args.force)
    os.makedirs(os.path.dirname(os.path.abspath(args.output)), exist_ok=True)
    msgs, bad, blank = load(src)
    plan = Plan(msgs, args.owner)
    conv = Converter(src, plan, args)
    problems = [(m, plan.problem(m)) for m in msgs if plan.problem(m)]
    ok = [m for m in msgs if not plan.problem(m)]
    chosen = pick_sample(ok, plan) if args.sample else ok

    now = dt.datetime.now().astimezone()
    tmp = args.output + '.partial'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        f.write("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n")
        f.write('<!--Converted from an SMS Import / Export backup by sie_to_sbr.py %s on %s. '
                'readable_date values are in %s.-->\n' % (VERSION, now.strftime('%Y-%m-%d %H:%M:%S %z'),
                                                          tz_label(args.tz)))
        f.write('<?xml-stylesheet type="text/xsl" href="sms.xsl"?>\n')
        f.write('<smses count="%d" backup_set="%s" backup_date="%d" type="full">\n'
                % (len(chosen), uuid.uuid4(), int(now.timestamp() * 1000)))
        for m in chosen:
            f.write(conv.sms(m) if m.kind == 'sms' else conv.mms(m))
        f.write('</smses>\n')
    os.replace(tmp, args.output)

    manifest = args.output[:-4] + '.manifest.csv'
    with open(manifest, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['xml_index', 'kind', 'direction', 'source_line', 'source_id', 'source_thread_id',
                    'source_sub_id', 'written_sub_id', 'date_ms', 'date_utc', 'address_written',
                    'parts', 'attachments', 'notes'])
        for i, m in enumerate(chosen, 1):
            o = m.o
            addr = sval(o, 'address') if m.kind == 'sms' else '~'.join(plan.address_list(m))
            w.writerow([i, m.kind, m.direction, m.line, sval(o, '_id'), sval(o, 'thread_id'),
                        sval(o, 'sub_id'), sub_id_for(o, args.sub_id), m.date_ms, utc(m.date_ms),
                        addr, len(mms_parts(o)) if m.kind == 'mms' else '',
                        sum(1 for p in mms_parts(o) if part_file(p)) if m.kind == 'mms' else '',
                        '; '.join(conv.notes.get(m.line, []))])

    report = []
    report += source_summary(src, msgs, bad, blank, plan)
    report += ['', 'CONVERSION',
               '  output:            %s (%s bytes)' % (os.path.abspath(args.output), format(os.path.getsize(args.output), ',')),
               '  mode:              %s' % ('test sample (--sample)' if args.sample else 'all messages'),
               '  written:           %d SMS + %d MMS = %d messages (count="%d")' % (
                   sum(m.kind == 'sms' for m in chosen), sum(m.kind == 'mms' for m in chosen), len(chosen), len(chosen)),
               '  attachments:       %d written (%s bytes), %d empty in the export, %d missing from the export' % (
                   conv.stats['attachments'] - conv.stats['attachments_missing'],
                   format(conv.stats['attachment_bytes'], ','), conv.stats['attachments_empty'],
                   conv.stats['attachments_missing']),
               '  not convertible:   %d record(s)%s' % (len(problems) + len(bad), '' if problems or bad else ' (none)')]
    for m, why in problems:
        report.append('    line %d (%s): %s' % (m.line, m.kind, why))
    for line, why in bad:
        report.append('    line %d: %s' % (line, why))
    report += ['  sub_id (SIM):      %s' % {
        'unknown': 'written as -1 ("SIM unknown") for every message; the old phone\'s values are in the manifest',
        'keep': 'the old phone\'s values written unchanged'}.get(args.sub_id, 'written as %s for every message' % args.sub_id),
               '  text changes:      %d field(s) had characters XML cannot store (%s)%s' % (
                   len(conv.changes), 'removed' if args.nul == 'strip' else 'replaced by U+FFFD',
                   '' if conv.changes else ' - none')]
    for line, kind, field, n, chars in conv.changes:
        report.append('    line %d (%s %s): %d x %s' % (line, kind, field, n, '/'.join(chars)))
    report.append('  MMS whose "address" comes from their conversation (headers list fewer people): %d'
                  % conv.stats['mms_address_from_conversation'])
    for m in chosen:
        if any(n.startswith('MMS headers') for n in conv.notes.get(m.line, [])):
            report.append('    line %d (thread %s)' % (m.line, sval(m.o, 'thread_id')))
    for m in chosen:
        for n in conv.notes.get(m.line, []):
            if 'attachment' in n:
                report.append('    line %d: %s' % (m.line, n))
    report += not_carried(chosen, args.sub_id)

    print('\n'.join(report))
    print('\nVerifying %s ...' % args.output)
    vreport, status = verify(src, msgs, plan, args)
    print('\n'.join(vreport))
    with open(args.output[:-4] + '.report.txt', 'w', encoding='utf-8') as f:
        f.write('SMS Import / Export -> SMS Backup & Restore conversion report (sie_to_sbr.py %s)\n' % VERSION)
        f.write('generated %s\n\n' % now.strftime('%Y-%m-%d %H:%M:%S %z'))
        f.write('\n'.join(report + [''] + vreport) + '\n')
    print('\nwrote %s\n      %s\n      %s' % (args.output, manifest, args.output[:-4] + '.report.txt'))
    return status


def source_summary(src, msgs, bad, blank, plan):
    sms = [m for m in msgs if m.kind == 'sms']
    mms = [m for m in msgs if m.kind == 'mms']
    parts = [p for m in mms for p in mms_parts(m.o)]
    refs = [part_file(p) for p in parts if part_file(p)]
    found = [r for r in refs if r in src.names]
    if src.kind == 'folder':
        empty = sum(1 for r in found if os.path.getsize(os.path.join(src.data_dir, r)) == 0)
    else:
        empty = sum(1 for r in found if src.zip.getinfo(src.members[r]).file_size == 0)
    dates = [m.date_ms for m in msgs if m.date_ms]
    count = lambda ms, f: ', '.join('%s %d' % (k, v) for k, v in sorted(collections.Counter(f(m) for m in ms).items()))
    return [
        'SOURCE',
        '  path:              %s (%s)' % (src.path, src.kind),
        '  format:            SMS Import / Export (com.github.tmo1.sms_ie) export: messages.ndjson + data/',
        '  records:           %d lines (%d blank, %d unreadable)' % (len(msgs) + len(bad) + blank, blank, len(bad)),
        '  SMS:               %d (%s)' % (len(sms), count(sms, lambda m: m.direction)),
        '  MMS:               %d (%s)' % (len(mms), count(mms, lambda m: m.direction)),
        '  MMS parts:         %d (%s)' % (len(parts), count(parts, lambda p: 'SMIL' if sval(p, 'ct') == 'application/smil'
                                                                else ('attachment' if part_file(p) else 'text'))),
        '  attachment files:  %d referenced, %d present, %d missing, %d empty (0 bytes); %d file(s) in data/ '
        'not referenced by any part' % (len(refs), len(found), len(refs) - len(found), empty,
                                         len(src.names - set(refs))),
        '  conversations:     %d thread_id values' % len({sval(m.o, 'thread_id') for m in msgs}),
        '  owner number:      %s (from %s)' % (', '.join(mask(k) for k in sorted(plan.owner)) or 'unknown',
                                               plan.owner_how),
        '  dates:             %s .. %s' % (utc(min(dates), '%Y-%m-%d %H:%M UTC'), utc(max(dates), '%Y-%m-%d %H:%M UTC'))
        if dates else '  dates:             none',
        '  SIM sub_id values: %s' % count(msgs, lambda m: str(sval(m.o, 'sub_id'))),
    ]


def not_carried(msgs, sub_policy):
    """Source fields with no place in SMS Backup & Restore's format (reported, not hidden)."""
    known_sms = set(SMS_ORDER) | set(K_NAME)
    known_mms = set(MMS_ORDER) | set(K_PARTS + K_SENDER + K_RECIPS + K_NAME)
    c = collections.Counter()
    for m in msgs:
        if m.kind == 'sms':
            c.update('sms.' + k for k in m.o if k not in known_sms)
        else:
            c.update('mms.' + k for k in m.o if k not in known_mms)
            for p in mms_parts(m.o):
                c.update('part.' + k for k in p if k not in PART_ATTRS and k != '_data')
            for r in mms_addr_rows(m.o):
                c.update('addr.' + k for k in r if k not in ADDR_ATTRS and k not in K_NAME)
        if sub_policy != 'keep' and sval(m.o, 'sub_id') is not None:
            c['%s.sub_id (old phone value)' % m.kind] += 1
    lines = ['  source fields not stored in the XML (no matching field in SMS Backup & Restore\'s format,',
             '  or specific to the old phone; ids and sub_id are kept in the manifest):']
    lines += ['    %-34s %d' % (k, v) for k, v in sorted(c.items())] or ['    none']
    return lines


# ----------------------------------------------------------------------------- verify

def digest(raw):
    return '%s:%d' % (hashlib.sha256(raw).hexdigest(), len(raw))


def expected_sms(m, args):
    o, nul = m.o, args.nul
    get = lambda k, fb: clean(sval(o, k), nul) if sval(o, k) is not None else fb
    return ('sms', get('address', None), get('date', None), get('type', None), get('body', 'null'),
            get('read', 'null'), get('status', 'null'), get('date_sent', None), get('protocol', None),
            get('locked', None), get('subject', 'null'), get('service_center', 'null'), get('toa', 'null'),
            get('sc_toa', 'null'), sub_id_for(o, args.sub_id))


def actual_sms(a):
    return ('sms',) + tuple(a.get(k) for k in ('address', 'date', 'type', 'body', 'read', 'status',
                                                'date_sent', 'protocol', 'locked', 'subject',
                                                'service_center', 'toa', 'sc_toa', 'sub_id'))


def expected_mms(m, args, src, hashes):
    o, nul = m.o, args.nul
    head = tuple(clean(sval(o, k), nul) if sval(o, k) is not None else (None if k in MMS_OMIT else 'null')
                 for k in MMS_COPIED)
    parts = []
    for p in mms_parts(o):
        vals = tuple(clean(sval(p, k), nul) if sval(p, k) is not None else 'null' for k in PART_ATTRS)
        name = part_file(p)
        if name and name in src.names:
            if name not in hashes:
                hashes[name] = digest(src.read_part(name))
            data = hashes[name]
        else:
            data = None
        parts.append(vals + (data,))
    addrs = tuple(tuple(clean(sval(r, k), nul) if sval(r, k) is not None else 'null' for k in ADDR_ATTRS)
                  for r in mms_addr_rows(o))
    return ('mms', str(m.date_ms), sub_id_for(o, args.sub_id)) + head + (tuple(parts), addrs)


def actual_mms(el, errors):
    a = el.attrib
    head = tuple(a.get(k) for k in MMS_COPIED)
    parts_el, addrs_el = el.findall('parts'), el.findall('addrs')
    if len(parts_el) != 1 or len(addrs_el) != 1 or len(el) != 2:
        errors.append('an <mms> does not have exactly one <parts> and one <addrs>')
    parts = []
    for p in (parts_el[0] if parts_el else []):
        data = p.get('data')
        if data is not None:
            try:
                data = digest(base64.b64decode(data, validate=True))
            except ValueError:
                errors.append('invalid base64 in a part of the MMS dated %s' % a.get('date'))
        parts.append(tuple(p.get(k) for k in PART_ATTRS) + (data,))
    addrs = tuple(tuple(x.get(k) for k in ADDR_ATTRS) for x in (addrs_el[0] if addrs_el else []))
    return ('mms', a.get('date'), a.get('sub_id')) + head + (tuple(parts), addrs)


def verify(src, msgs, plan, args):
    """Re-read the XML with a strict parser and match every element to its source record."""
    tz = get_tz(args.tz)
    out, errors = [], []
    expected = collections.defaultdict(list)
    hashes = {}
    candidates = [m for m in msgs if not plan.problem(m)]
    for m in candidates:
        key = expected_sms(m, args) if m.kind == 'sms' else expected_mms(m, args, src, hashes)
        expected[key].append(m)

    with open(args.output, 'rb') as f:
        head = f.read(200)
    if not head.startswith(b"<?xml version='1.0' encoding='UTF-8'"):
        errors.append('the file does not start with the XML declaration SMS Backup & Restore writes')

    matched, unmatched, n_sms, n_mms, root_attrs = [], [], 0, 0, {}
    bad_dates, bad_names, bad_tags = 0, 0, collections.Counter()
    root = None
    try:
        for event, el in ET.iterparse(args.output, events=('start', 'end')):
            if event == 'start':
                if root is None:
                    root, root_attrs = el, dict(el.attrib)
                continue
            if el is root:
                break
            if el.tag in ('part', 'addr', 'parts', 'addrs'):
                continue
            if el.tag == 'sms':
                n_sms += 1
                key = actual_sms(el.attrib)
                if len(el):
                    errors.append('an <sms> has child elements')
            elif el.tag == 'mms':
                n_mms += 1
                key = actual_mms(el, errors)
            else:
                bad_tags[el.tag] += 1
                root.clear()
                continue
            a = el.attrib
            if is_int(a.get('date')) and a.get('readable_date') != readable(int(a['date']), tz):
                bad_dates += 1
            if not a.get('contact_name'):
                bad_names += 1
            if expected.get(key):
                matched.append((expected[key].pop(), a.get('address')))
            else:
                unmatched.append((el.tag, a.get('date')))
            root.clear()
    except ET.ParseError as e:
        errors.append('XML is not well-formed: %s' % e)

    total = n_sms + n_mms
    if root is None or root.tag != 'smses':
        errors.append('root element is not <smses>')
    if root_attrs.get('count') != str(total):
        errors.append('count="%s" but the file holds %d messages' % (root_attrs.get('count'), total))
    if bad_tags:
        errors.append('unexpected elements: %s' % dict(bad_tags))
    if unmatched:
        errors.append('%d message(s) in the XML do not match any source record exactly, e.g. %s'
                      % (len(unmatched), unmatched[:3]))
    left = [m for ms in expected.values() for m in ms]
    if left and not args.sample:
        errors.append('%d source message(s) are missing from the XML, e.g. lines %s'
                      % (len(left), [m.line for m in left[:5]]))
    if bad_dates:
        errors.append('%d readable_date value(s) do not match their date' % bad_dates)
    if bad_names:
        errors.append('%d message(s) without contact_name' % bad_names)

    # Conversations: Android files each restored message under the participant set in its
    # address attribute, so check those sets against the old phone's thread_id values.
    by_thread, mms_problems = collections.defaultdict(set), 0
    for m, address in matched:
        if m.kind == 'sms':
            key = frozenset([addr_key(address)])
        else:
            key = frozenset(addr_key(x) for x in (address or '').split('~'))
            own = frozenset(addr_key(a) for a in plan.others(m.o))
            if not own <= key or (key & plan.owner and key - plan.owner):
                mms_problems += 1
        by_thread[sval(m.o, 'thread_id')].add(key)
    if mms_problems:
        errors.append('%d MMS have an address attribute that leaves out a participant or includes '
                      'the owner' % mms_problems)
    split = {t: ks for t, ks in by_thread.items() if len(ks) > 1}
    owners = collections.defaultdict(set)
    for t, ks in by_thread.items():
        for k in ks:
            owners[k].add(t)
    merged = {k: ts for k, ts in owners.items() if len(ts) > 1}

    sources = collections.Counter(m.kind for m in candidates)
    written = collections.Counter(m.kind for m, _ in matched)
    out += ['VERIFICATION (strict XML parser, every element compared field by field with its source record)',
            '  well-formed XML:          %s' % ('no' if any('well-formed' in e for e in errors) else 'yes'),
            '  messages in file:         %d SMS + %d MMS = %d; root count="%s"' % (
                n_sms, n_mms, total, root_attrs.get('count')),
            '  matched to source exactly: %d SMS of %d, %d MMS of %d%s' % (
                written['sms'], sources['sms'], written['mms'], sources['mms'],
                ' (test sample)' if args.sample else ''),
            '    compared: addresses, bodies/texts, dates (MMS seconds x 1000), type/msg_box, read,',
            '    seen, status, every MMS header, every part (attachments by SHA-256), every addr row',
            '  attachments checked:      %d distinct files' % len(hashes),
            '  conversations predicted after restore: %d (from %d old thread_id values)' % (
                len(owners), len(by_thread))]
    for t, ks in sorted(split.items(), key=lambda x: str(x[0])):
        out.append('    old thread %s will appear as %d conversations: %s' % (
            t, len(ks), ' + '.join('[%s]' % ', '.join(mask(x) for x in sorted(k)) if len(k) < 4
                                   else '[%d people]' % len(k) for k in ks)))
    for k, ts in merged.items():
        out.append('    old threads %s will share one conversation [%s]' % (
            sorted(ts, key=str), ', '.join(mask(x) for x in sorted(k))))
    out.append('  result: %s' % ('PASSED' if not errors else 'FAILED'))
    out += ['    ! ' + e for e in errors]
    return out, (0 if not errors else 1)


def cmd_verify(args):
    src = Source(args.source)
    msgs, bad, blank = load(src)
    report, status = verify(src, msgs, Plan(msgs, args.owner), args)
    print('\n'.join(report))
    return status


def cmd_analyze(args):
    src = Source(args.source)
    msgs, bad, blank = load(src)
    plan = Plan(msgs, args.owner)
    print('\n'.join(source_summary(src, msgs, bad, blank, plan) + not_carried(msgs, 'keep')))
    for m in msgs:
        if plan.problem(m):
            print('  not convertible: line %d (%s): %s' % (m.line, m.kind, plan.problem(m)))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='command', required=True)
    for name in ('analyze', 'convert', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('source', help='the SMS Import / Export .zip, or the folder it was extracted to')
        if name != 'analyze':
            p.add_argument('output', help='the XML file to write / check, e.g. sms-20261005120000.xml')
            p.add_argument('--sample', action='store_true',
                           help='write only a small representative test set')
            p.add_argument('--sub-id', default='unknown',
                           help='SIM id written for every message: "unknown" (-1, default; visible on any '
                                'phone), "keep" (the old phone\'s values) or a number')
            p.add_argument('--tz', help='IANA time zone for readable_date (display only), e.g. '
                                        'America/New_York; default: this computer\'s')
            p.add_argument('--nul', choices=('strip', 'replace'), default='strip',
                           help='characters XML cannot store (e.g. U+0000): remove them (default) or '
                                'replace them with U+FFFD')
        p.add_argument('--owner', help='your own number(s), comma-separated, if auto-detection is wrong')
        if name == 'convert':
            p.add_argument('--force', action='store_true', help='replace an existing output file')
    args = ap.parse_args()
    if getattr(args, 'sub_id', 'unknown') not in ('unknown', 'keep') and not is_int(args.sub_id):
        ap.error('--sub-id must be "unknown", "keep" or a number')
    return {'analyze': cmd_analyze, 'convert': cmd_convert, 'verify': cmd_verify}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
