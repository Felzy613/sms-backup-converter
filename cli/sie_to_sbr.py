#!/usr/bin/env python3
"""
sie_to_sbr.py - convert a message backup from one phone's format to another's, then
verify the result. Made for moving texts between kosher phones and ordinary Android.

SOURCE  (detected from the file's contents)
  Fig / TAK   SMS Import / Export (com.github.tmo1.sms_ie) export, the original
              messages-YYYY-MM-DD.zip or its extracted folder:
                messages.ndjson  one JSON object per line: SMS rows (the columns of
                                 Android's content://sms) and MMS rows (content://mms)
                                 plus __display_name, __sender_address,
                                 __recipient_addresses, __parts
                data/PART_*      MMS attachment files, matched to a part by the file
                                 name at the end of the part's "_data" path
  SMS Backup & Restore  its sms-*.xml file (attachments inside, as base64)
  Wonder      a ZIP with one XML file (<messages>) and mms_attachments/
  Pom         a ZIP with sms.xml and mms.xml (attachments inside as _data_b64)
  Buggy Backup  a ZIP with conversations/conv_N (one JSON message each; SMS only)
TARGET  --to sbr     (default) the XML restored by SMS Backup & Restore:
                     https://www.synctech.com.au/sms-backup-restore/fields-in-xml-backup-files/
        --to fig     a messages.ndjson + data/ ZIP, as SMS Import / Export (Fig, TAK) imports
        --to wonder  a ZIP with Messages_Backup_YYYY-MM-DD.xml and mms_attachments/

Every format is read into the same records (the columns of Android's message tables)
and written from them. The source is only ever opened for reading. Standard library
only (Python 3.8+). The browser app (index.html / assets/converter.js) and the Android
app (android/core) write byte-identical files; tests/test_all.py checks that.

  python3 sie_to_sbr.py analyze SOURCE
  python3 sie_to_sbr.py convert SOURCE sms-20261005120000.xml
  python3 sie_to_sbr.py convert SOURCE sms-test-20261005120000.xml --sample
  python3 sie_to_sbr.py convert SOURCE messages-2026-10-05.zip --to fig --keep sms
  python3 sie_to_sbr.py verify  SOURCE sms-20261005120000.xml

`convert` always checks the file(s) it wrote (SMS Backup & Restore XML is re-read with
a strict parser and matched field by field; ZIP outputs are re-read and compared), and
also writes <output>.manifest.csv (one row per written message, with its source record,
old row id, thread id and SIM id) and <output>.report.txt. With --split-mb, outputs
bigger than that are written as <output>-part1, -part2, ..., to be restored in order.
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
import shutil
import struct
import sys
import tempfile
import time
import uuid
import zipfile
import zlib
import xml.etree.ElementTree as ET

VERSION = '1.1.0'
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

TARGETS = ('sbr', 'fig', 'wonder')
TARGET_NAMES = {'sbr': 'SMS Backup & Restore XML', 'fig': 'Fig / TAK (SMS Import / Export ZIP)',
                'wonder': 'Wonder ZIP'}
APP_PARTS = '/data/user_de/0/com.android.providers.telephony/app_parts/'  # where Android keeps MMS files
# Buggy Backup stores each SMS as JSON with one-letter keys; these are the Android columns.
BUGGY_KEYS = (('q', 'address'), ('r', 'body'), ('m', 'date'), ('n', 'date_sent'), ('h', 'type'), ('b', 'read'),
              ('k', 'protocol'), ('g', 'status'), ('d', 'locked'), ('l', 'sub_id'), ('o', 'creator'), ('e', 'seen'))
# File name extensions for attachments written to a Wonder ZIP.
EXTENSIONS = {'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp',
              'image/webp': 'webp', 'audio/amr': 'amr', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'video/mp4': 'mp4',
              'video/3gpp': '3gp', 'application/pdf': 'pdf', 'text/x-vcard': 'vcf', 'text/vcard': 'vcf'}


# ----------------------------------------------------------------------------- source

class SieSource:
    """Read-only access to an SMS Import / Export export (zip file or extracted folder).
    Fig and TAK phones write this format; so did Pom's older system."""

    format = 'sie'
    describe = 'Fig / TAK: SMS Import / Export (com.github.tmo1.sms_ie) export: messages.ndjson + data/'
    unit = 'line'

    def __init__(self, path, zf=None):
        self.path = os.path.abspath(path)
        self.zip = None
        if os.path.isdir(self.path):
            self.kind = 'folder'
            self.ndjson = os.path.join(self.path, 'messages.ndjson')
            if not os.path.isfile(self.ndjson):
                sys.exit('error: %s not found' % self.ndjson)
            self.data_dir = os.path.join(self.path, 'data')
            self.names = set(os.listdir(self.data_dir)) if os.path.isdir(self.data_dir) else set()
        else:
            self.kind = 'zip'
            self.zip = zf or zipfile.ZipFile(self.path)
            members = self.zip.namelist()
            found = [n for n in members if n.rsplit('/', 1)[-1] == 'messages.ndjson']
            if not found:
                sys.exit('error: no messages.ndjson inside %s' % self.path)
            self.ndjson = min(found, key=len)
            prefix = self.ndjson[:-len('messages.ndjson')] + 'data/'
            self.members = {n[len(prefix):]: n for n in members
                            if n.startswith(prefix) and not n.endswith('/')}
            self.names = set(self.members)

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

    def part_size(self, name):
        if self.zip:
            return self.zip.getinfo(self.members[name]).file_size
        return os.path.getsize(os.path.join(self.data_dir, name))

    def load(self):
        msgs, bad, blank = [], [], 0
        for number, raw in self.lines():
            if not raw.strip():
                blank += 1
                continue
            try:
                o = json.loads(raw.decode('utf-8'))
            except (UnicodeDecodeError, ValueError) as e:
                bad.append((number, 'unreadable line: %s' % e))
                continue
            kind = classify(o)
            if kind:
                msgs.append(Msg(number, kind, o))
            else:
                bad.append((number, 'line is not a JSON object' if not isinstance(o, dict)
                            else 'neither an SMS nor an MMS record'))
        return msgs, bad, blank

    def close(self):
        pass


def classify(o):
    """'sms', 'mms', or None for a record that is neither."""
    if not isinstance(o, dict):
        return None
    if pick(o, K_PARTS) is not None or 'msg_box' in o or 'm_type' in o:
        return 'mms'
    if 'body' in o or 'address' in o:
        return 'sms'
    return None


class AttachmentStore:
    """Attachments that a backup keeps inside its XML as base64 (SMS Backup & Restore,
    Pom): decoded into a temporary folder while reading, so a backup of several GB never
    has to fit in memory. Each one is named ATT_<n>, n counting in document order."""

    B64 = re.compile('[A-Za-z0-9+/]*={0,2}')

    def __init__(self, workdir=None):
        self.dir = tempfile.mkdtemp(prefix='sms-convert-', dir=workdir)
        self.sizes = {}
        self.count = 0

    def add(self, text):
        """Stores base64 text; returns its name. Text that is not valid base64 gets a name
        too, but no file, so the part is reported as an attachment missing from the backup."""
        self.count += 1
        name = 'ATT_%d' % self.count
        b64 = re.sub('[ \t\r\n]', '', text)
        if len(b64) % 4 == 0 and self.B64.fullmatch(b64):
            data = base64.b64decode(b64)
            with open(os.path.join(self.dir, name), 'wb') as f:
                f.write(data)
            self.sizes[name] = len(data)
        return name

    def read(self, name):
        with open(os.path.join(self.dir, name), 'rb') as f:
            return f.read()

    def close(self):
        shutil.rmtree(self.dir, ignore_errors=True)


def from_attrs(attrs, skip=()):
    """A record from XML attributes: SMS Backup & Restore writes NULL columns as "null"."""
    return {k: (None if v == 'null' else v) for k, v in attrs.items() if k not in skip}


def xml_records(f, flavor, store):
    """Yields ('sms'|'mms', record) for each message in an XML backup, in document order.

    flavor 'sbr'    <smses><sms/><mms><parts><part data=base64/></parts><addrs><addr/></addrs></mms>
           'wonder' <messages><sms/><mms><addr/><part file=NAME text=.../></mms>
           'pom'    sms.xml <smses><sms/>; mms.xml <mmses><mms><addr/><r/><part _data_b64=.../></mms>
    Attribute values become the record's columns ("null" -> None); computed attributes
    (readable_date, contact_name, an MMS's address) are left out."""
    mms, parts, rows, recips = None, [], [], []
    root = None
    for event, el in ET.iterparse(f, events=('start', 'end')):
        tag = el.tag
        if event == 'start':
            if root is None:
                root = el
                continue
            a = el.attrib
            if mms is None:
                if tag == 'sms':
                    o = from_attrs(a, ('readable_date', 'contact_name'))
                    if a.get('body') == 'null':
                        o['body'] = 'null'  # a text that says "null"
                    name = a.get('contact_name')
                    if name not in (None, '', 'null', '(Unknown)'):
                        o['__display_name'] = name
                    yield 'sms', o
                elif tag == 'mms':
                    mms, parts, rows, recips = from_attrs(a, ('address', 'readable_date', 'contact_name')), [], [], []
            elif tag == 'part':
                p = from_attrs(a, ('data', '_data_b64', 'file'))
                if 'seq' not in a:
                    p['seq'] = '-1' if a.get('ct') == 'application/smil' else '0'
                if flavor == 'sbr' and 'data' in a:
                    p['_data'] = store.add(a['data'])
                elif flavor == 'pom' and a.get('_data_b64') not in (None, '', 'null'):
                    p['_data'] = store.add(a['_data_b64'])
                elif flavor == 'wonder' and a.get('file'):
                    p['_data'] = a['file'].replace('\\', '/').rsplit('/', 1)[-1]
                parts.append(p)
            elif tag == 'addr':
                r = from_attrs(a)
                if flavor == 'pom' and r.get('address'):
                    r['address'] = re.sub('/TYPE=PLMN$', '', r['address'], flags=re.I)
                rows.append(r)
            elif tag == 'r' and flavor == 'pom' and a.get('address'):
                recips.append(a['address'])
        else:
            if tag == 'mms' and mms is not None:
                if not rows:
                    rows = [{'address': x, 'type': '151', 'charset': '106'} for x in recips]
                rows = [r if '_id' in r else dict([('_id', str(i))] + list(r.items())) for i, r in enumerate(rows, 1)]
                sender = next((r for r in rows if r.get('type') == '137'), None)
                if sender is not None:
                    mms['__sender_address'] = sender
                mms['__recipient_addresses'] = [r for r in rows if r is not sender]
                mms['__parts'] = parts
                yield 'mms', mms
                mms = None
                root.clear()
            elif tag == 'sms' and mms is None:
                root.clear()


def xml_root(f):
    """The name of an XML document's root element, or None if it is not XML."""
    try:
        for _, el in ET.iterparse(f, events=('start',)):
            return el.tag
    except ET.ParseError:
        return None
    return None


class XmlSource:
    """A backup kept in XML: SMS Backup & Restore (a .xml file, or one inside a ZIP),
    Wonder (a ZIP with one XML file and mms_attachments/) or Pom (a ZIP with sms.xml and
    mms.xml)."""

    unit = 'record'

    def __init__(self, path, fmt, zf=None, members=(), workdir=None):
        self.path, self.format, self.zip, self.members = os.path.abspath(path), fmt, zf, list(members)
        self.kind = 'zip' if zf else 'file'
        self.store = AttachmentStore(workdir)
        self.files = {}
        self.describe = {
            'sbr': 'SMS Backup & Restore XML backup (attachments inside, as base64)',
            'wonder': 'Wonder ZIP backup: an XML file + mms_attachments/',
            'pom': 'Pom ZIP backup: sms.xml + mms.xml (attachments inside, as base64)'}[fmt]
        if fmt == 'wonder' and zf:
            for n in zf.namelist():
                if n.startswith('mms_attachments/') and not n.endswith('/'):
                    self.files.setdefault(n.rsplit('/', 1)[-1], n)
        self.names = set(self.files)

    def open(self, member):
        return self.zip.open(member) if self.zip else open(self.path, 'rb')

    def load(self):
        msgs, record = [], 0
        try:
            for member in self.members or [None]:
                flavor = self.format
                with self.open(member) as f:
                    for kind, o in xml_records(f, flavor, self.store):
                        record += 1
                        msgs.append(Msg(record, kind, o))
        except ET.ParseError as e:
            sys.exit('error: the backup\'s XML is damaged (%s)' % e)
        if self.format != 'wonder':
            self.names = set(self.store.sizes)
        return msgs, [], 0

    def read_part(self, name):
        if name in self.files:
            with self.zip.open(self.files[name]) as f:
                return f.read()
        return self.store.read(name)

    def part_size(self, name):
        if name in self.files:
            return self.zip.getinfo(self.files[name]).file_size
        return self.store.sizes[name]

    def close(self):
        self.store.close()


class BuggySource:
    """A Buggy Backup ZIP: conversations/conv_<n>, each one SMS as JSON with one-letter
    keys (see BUGGY_KEYS). It holds no MMS."""

    format = 'buggy'
    describe = 'Buggy Backup ZIP: conversations/conv_N (SMS only)'
    unit = 'record'
    kind = 'zip'
    names = set()

    def __init__(self, path, zf):
        self.path, self.zip = os.path.abspath(path), zf
        entries = [(int(m.group(1)), n) for n in zf.namelist() for m in [re.fullmatch('conversations/conv_([0-9]+)', n)] if m]
        self.entries = [n for _, n in sorted(entries)]

    def load(self):
        msgs, bad = [], []
        for record, name in enumerate(self.entries, 1):
            try:
                obj = json.loads(self.zip.read(name).decode('utf-8'))
            except (UnicodeDecodeError, ValueError) as e:
                bad.append((record, 'unreadable entry %s: %s' % (name, e)))
                continue
            if not isinstance(obj, dict):
                bad.append((record, 'entry %s is not a JSON object' % name))
                continue
            o = {col: obj[key] for key, col in BUGGY_KEYS if key in obj}
            if classify(o):
                msgs.append(Msg(record, 'sms', o))
            else:
                bad.append((record, 'entry %s has neither an address nor a text' % name))
        return msgs, bad, 0

    def read_part(self, name):
        raise KeyError(name)

    def part_size(self, name):
        raise KeyError(name)

    def close(self):
        pass


def open_source(path, workdir=None):
    """Detects the backup's format from its contents and opens it."""
    if os.path.isdir(path):
        return SieSource(path)
    if not os.path.isfile(path):
        sys.exit('error: %s not found' % path)
    if zipfile.is_zipfile(path):
        zf = zipfile.ZipFile(path)
        names = zf.namelist()
        if any(n.rsplit('/', 1)[-1] == 'messages.ndjson' for n in names):
            return SieSource(path, zf)
        if any(re.fullmatch('conversations/conv_[0-9]+', n) for n in names):
            return BuggySource(path, zf)
        if any(n in ('sms.xml', 'mms.xml', '_pom_backup_manifest.json') for n in names):
            return XmlSource(path, 'pom', zf, [n for n in ('sms.xml', 'mms.xml') if n in names], workdir)
        tops = [n for n in names if '/' not in n and n.lower().endswith('.xml')]
        if tops:
            with zf.open(tops[0]) as f:
                root = xml_root(f)
            if root == 'smses':
                return XmlSource(path, 'sbr', zf, tops[:1], workdir)
            if root == 'messages':
                return XmlSource(path, 'wonder', zf, tops[:1], workdir)
        sys.exit('error: %s is a ZIP file, but not a backup this converter knows (Fig/TAK, SMS Backup & '
                 'Restore, Wonder, Pom or Buggy Backup)' % path)
    with open(path, 'rb') as f:
        root = xml_root(f)
    if root == 'smses':
        return XmlSource(path, 'sbr', workdir=workdir)
    if root == 'messages':
        return XmlSource(path, 'wonder', workdir=workdir)
    if root == 'calls':
        sys.exit('error: %s is a call log backup, not a message backup' % path)
    sys.exit('error: %s is not a message backup this converter knows (Fig/TAK, SMS Backup & Restore, '
             'Wonder, Pom or Buggy Backup)' % path)


class Msg:
    """One source record: its line number in messages.ndjson (its position, for other
    formats), 'sms' or 'mms', and its columns."""

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
    return src.load()


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


def nstr(s):
    """A value for a message text: None as "null", as JavaScript and Kotlin print it."""
    return 'null' if s is None else s


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


def is_pdf(p):
    return (sval(p, 'ct') or '').split(';')[0].strip().lower() == 'application/pdf'


def written_parts(o, args):
    """The MMS parts that are written: all of them, or all but PDF files with --no-pdf."""
    parts = mms_parts(o)
    return [p for p in parts if not is_pdf(p)] if args.no_pdf else parts


def u8len(s):
    """The UTF-8 size of a text; an unpaired surrogate counts as 3 bytes."""
    return len(s.encode('utf-8', 'surrogatepass')) if s else 0


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


def pick_sample(msgs, plan, by_chat=False):
    """A small, representative test set: the one-to-one conversation with the most kinds of
    message (SMS both ways, MMS with attachments both ways, a text-only MMS, SMS with line
    breaks / emoji / XML special characters) and the largest group conversation (received
    with and without attachments, sent). Conversations are the old thread_id values, or, for formats that
    have none (by_chat), the participants."""
    by_thread = collections.defaultdict(list)
    for m in msgs:
        by_thread[chat_key(plan, m) if by_chat else sval(m.o, 'thread_id')].append(m)

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
        if t is None or any(group(m) for m in mms):
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
        for p in written_parts(o, self.args):
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
                                                  'export' % (name, nstr(sval(p, 'ct'))))
                else:
                    self.stats['attachments_missing'] += 1
                    self.notes[m.line].append('attachment file %s (%s) is not in the export; part written '
                                              'without data' % (name, nstr(sval(p, 'ct'))))
            out.append(line[:-1] + ' />\n')
        out.append('    </parts>\n    <addrs>\n')
        for r in mms_addr_rows(o):
            out.append(self.tag('      ', 'addr', [(k, sval(r, k) if sval(r, k) is not None else 'null')
                                                   for k in ADDR_ATTRS], m, 'addr.'))
        out.append('    </addrs>\n  </mms>\n')
        return ''.join(out)


def guard_output(src, out, force, target):
    out = os.path.abspath(out)
    if out == src.path or (src.kind == 'folder' and (
            out == src.ndjson or out.startswith(os.path.join(src.path, 'data') + os.sep))):
        sys.exit('error: refusing to write into the source backup')
    ext = '.xml' if target == 'sbr' else '.zip'
    if not out.lower().endswith(ext):
        sys.exit('error: the output file name must end in %s%s' % (
            ext, ' (SMS Backup & Restore lists sms-*.xml)' if target == 'sbr' else ''))
    if os.path.exists(out) and not force:
        sys.exit('error: %s already exists (use --force to replace it)' % out)


# ----------------------------------------------------------------------------- choosing

def choose(src, msgs, plan, args):
    """Splits the records into problems and convertible ones, applies the "what to keep"
    options, and picks the test sample. Returns (problems, ok, chosen, left_out) where
    left_out counts the records each option left out."""
    problems = [(m, plan.problem(m)) for m in msgs if plan.problem(m)]
    ok = [m for m in msgs if not plan.problem(m)]
    kept, left_out = [], collections.Counter()
    for m in ok:
        if args.keep == 'sms' and m.kind != 'sms':
            left_out['mms'] += 1
        elif args.keep == 'mms' and m.kind != 'mms':
            left_out['sms'] += 1
        elif args.no_groups and m.kind == 'mms' and len(plan.address_list(m)) > 1:
            left_out['groups'] += 1
        else:
            kept.append(m)
    chosen = pick_sample(kept, plan, src.format != 'sie') if args.sample else kept
    if args.no_pdf:
        left_out['pdf'] = sum(1 for m in chosen if m.kind == 'mms' for p in mms_parts(m.o) if is_pdf(p))
    return problems, ok, chosen, left_out


def chat_key(plan, m):
    """The conversation a message is restored into: its participants, without the owner."""
    if m.kind == 'sms':
        return addr_key(sval(m.o, 'address'))
    return ','.join(sorted({addr_key(a) for a in plan.address_list(m)}))


def estimate(m, src, args):
    """About how many bytes the message takes in the output (attachments exactly)."""
    o = m.o
    if m.kind == 'sms':
        return 200 + u8len(sval(o, 'body')) + u8len(sval(o, 'address'))
    n = 1000 + 100 * len(mms_addr_rows(o))
    for p in written_parts(o, args):
        n += 200 + u8len(sval(p, 'text'))
        name = part_file(p)
        if name and name in src.names:
            size = src.part_size(name)
            n += 4 * ((size + 2) // 3) if args.to == 'sbr' else size
    return n


def split_messages(chosen, src, plan, args):
    """The messages of each output file. With --split-mb, a conversation goes into one file
    whenever it fits, a message is never split, and files hold their messages in the
    original order; restored one after another, they give back every message."""
    limit = int(args.split_mb * 1048576)
    if limit <= 0:
        return [chosen]
    chats = collections.OrderedDict()
    for m in chosen:
        chats.setdefault(chat_key(plan, m), []).append(m)
    parts, cur, size = [], [], 0
    for ms in chats.values():
        sizes = [estimate(m, src, args) for m in ms]
        if cur and size + sum(sizes) > limit:
            parts.append(cur)
            cur, size = [], 0
        for m, n in zip(ms, sizes):
            if cur and size + n > limit:
                parts.append(cur)
                cur, size = [], 0
            cur.append(m)
            size += n
    if cur:
        parts.append(cur)
    index = {id(m): i for i, m in enumerate(chosen)}
    return [sorted(p, key=lambda m: index[id(m)]) for p in parts]


# ----------------------------------------------------------------------------- writing

class ZipWriter:
    """Writes a ZIP archive of stored (uncompressed) entries with their sizes in the
    local headers and no data descriptors, which every importer accepts (Fig's rejects
    some other ZIP layouts); ZIP64 records only when an archive needs them."""

    def __init__(self, f, when):
        self.f, self.offset, self.entries = f, 0, []
        year = min(max(when.year, 1980), 2107)
        self.time = (when.hour << 11) | (when.minute << 5) | (when.second // 2)
        self.date = ((year - 1980) << 9) | (when.month << 5) | when.day

    def add(self, name, data):
        nb = name.encode('utf-8')
        crc, size = zlib.crc32(data) & 0xffffffff, len(data)
        big = size >= 0xffffffff or self.offset >= 0xffffffff
        extra = struct.pack('<HHQQ', 1, 16, size, size) if big else b''
        self.f.write(struct.pack('<IHHHHHIIIHH', 0x04034b50, 45 if big else 20, 0x0800, 0, self.time, self.date,
                                 crc, 0xffffffff if big else size, 0xffffffff if big else size, len(nb), len(extra)))
        self.f.write(nb + extra)
        self.f.write(data)
        self.entries.append((nb, crc, size, self.offset))
        self.offset += 30 + len(nb) + len(extra) + size

    def close(self):
        start, cd = self.offset, []
        for nb, crc, size, off in self.entries:
            big = size >= 0xffffffff or off >= 0xffffffff
            extra = struct.pack('<HHQQQ', 1, 24, size, size, off) if big else b''
            cd.append(struct.pack('<IHHHHHHIIIHHHHHII', 0x02014b50, 45 if big else 20, 45 if big else 20, 0x0800, 0,
                                  self.time, self.date, crc, 0xffffffff if big else size,
                                  0xffffffff if big else size, len(nb), len(extra), 0, 0, 0, 0,
                                  0xffffffff if big else off) + nb + extra)
        cd = b''.join(cd)
        self.f.write(cd)
        n, end = len(self.entries), start + len(cd)
        if n >= 0xffff or start >= 0xffffffff or len(cd) >= 0xffffffff:
            self.f.write(struct.pack('<IQHHIIQQQQ', 0x06064b50, 44, 45, 45, 0, 0, n, n, len(cd), start))
            self.f.write(struct.pack('<IIQI', 0x07064b50, 0, end, 1))
            self.f.write(struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, 0xffff, 0xffff, 0xffffffff, 0xffffffff, 0))
        else:
            self.f.write(struct.pack('<IHHHHIIH', 0x06054b50, 0, 0, n, n, len(cd), start, 0))


def jstr(s):
    """A JSON string exactly as JavaScript's JSON.stringify writes it."""
    return '"' + JSON_ESCAPE_RE.sub(lambda m: JSON_ESCAPES.get(m.group()) or '\\u%04x' % ord(m.group()), s) + '"'


JSON_ESCAPES = {'"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'}
JSON_ESCAPE_RE = re.compile('["\\\\\x00-\x1f\ud800-\udfff]')


def jdump(v):
    """JSON text exactly as JavaScript's JSON.stringify writes it (no spaces)."""
    if v is None:
        return 'null'
    if v is True:
        return 'true'
    if v is False:
        return 'false'
    if isinstance(v, int):
        return str(v)
    if isinstance(v, float):
        return json.dumps(v)
    if isinstance(v, str):
        return jstr(v)
    if isinstance(v, list):
        return '[' + ','.join(jdump(x) for x in v) + ']'
    return '{' + ','.join(jstr(k) + ':' + jdump(x) for k, x in v.items()) + '}'


def attachment_note(conv, m, p, name, present, size):
    """Counts an attachment and notes an empty or missing one (the same for every format)."""
    conv.stats['attachments'] += 1
    if not present:
        conv.stats['attachments_missing'] += 1
        conv.notes[m.line].append('attachment file %s (%s) is not in the export; part written without data'
                                  % (name, nstr(sval(p, 'ct'))))
    else:
        conv.stats['attachment_bytes'] += size
        if not size:
            conv.stats['attachments_empty'] += 1
            conv.notes[m.line].append('attachment %s (%s) is an empty (0-byte) file in the export'
                                      % (name, nstr(sval(p, 'ct'))))


def fig_ids(chosen, plan):
    """Row and thread ids for records that come from another format (Fig's importer, SMS
    Import / Export, expects them): numbered in the order written, threads by participants."""
    ids, threads = {}, {}
    for i, m in enumerate(chosen, 1):
        key = chat_key(plan, m)
        threads.setdefault(key, str(len(threads) + 1))
        ids[id(m)] = (str(i), threads[key])
    return ids


def fig_part(msgs, src, plan, args, conv, ids):
    """messages.ndjson and its data/ files for one output file, as SMS Import / Export
    writes them. Records from an SMS Import / Export export are written back unchanged
    except for the options (SIM id, PDFs)."""
    lines, files, seen, k = [], [], set(), 0
    for m in msgs:
        o = m.o
        if src.format == 'sie':
            obj = json.loads(json.dumps(o))
            key = next((x for x in K_PARTS if isinstance(obj.get(x), list)), None)
            if m.kind == 'mms' and args.no_pdf and key:
                obj[key] = [p for p in obj[key] if not (isinstance(p, dict) and is_pdf(p))]
        else:
            rid, tid = ids[id(m)]
            obj = {'_id': rid, 'thread_id': tid}
            for key, v in o.items():
                if key not in ('_id', 'thread_id', '__sender_address', '__recipient_addresses', '__parts'):
                    obj[key] = v
            if args.sub_id != 'keep':
                obj['sub_id'] = sub_id_for(o, args.sub_id)
            if m.kind == 'mms':
                d = sval(o, 'date')
                if is_int(d) and int(d) >= 10 ** 11:
                    obj['date'] = str(int(d) // 1000)
                sender = o.get('__sender_address')
                if isinstance(sender, dict):
                    obj['__sender_address'] = dict(sender, msg_id=rid)
                obj['__recipient_addresses'] = [dict(r, msg_id=rid) for r in o.get('__recipient_addresses') or []
                                                if isinstance(r, dict)]
                obj['__parts'] = [dict(p, mid=rid) for p in written_parts(o, args)]
        if src.format == 'sie' and args.sub_id != 'keep':
            obj['sub_id'] = sub_id_for(o, args.sub_id)
        if m.kind == 'mms':
            parts = pick(obj, K_PARTS)
            for p in (parts if isinstance(parts, list) else []):
                if not isinstance(p, dict):
                    continue
                name = part_file(p)
                if not name:
                    continue
                present = name in src.names
                attachment_note(conv, m, p, name, present, src.part_size(name) if present else 0)
                if src.format == 'sie':
                    if present and name not in seen:
                        seen.add(name)
                        files.append(('data/' + name, name))
                elif present:
                    k += 1
                    p['_data'] = APP_PARTS + 'PART_%d' % k
                    files.append(('data/PART_%d' % k, name))
                else:
                    del p['_data']
        lines.append(jdump(obj))
    return ('\n'.join(lines) + '\n').encode('utf-8', 'surrogatepass'), files


def ext_for(ct, label):
    base = (ct or '').split(';')[0].strip().lower()
    if base in EXTENSIONS:
        return EXTENSIONS[base]
    m = re.search('\\.([A-Za-z0-9]{1,5})$', label or '')
    return m.group(1).lower() if m else 'bin'


def wonder_smil(refs):
    body = ''.join('<par dur="5000ms"><%s src="%s" region="Image"/></par>' % (
        'img' if ct.startswith('image/') else 'video' if ct.startswith('video/') else
        'audio' if ct.startswith('audio/') else 'ref', esc(label)) for ct, label in refs)
    return ('<smil><head><layout><root-layout/><region id="Image" fit="meet" top="0" left="0" height="100%" '
            'width="100%"/></layout></head><body>' + body + '</body></smil>')


def wonder_part(msgs, src, args, conv):
    """The XML file and mms_attachments/ files of a Wonder backup."""
    out = ['<?xml version="1.0" encoding="UTF-8"?>\n<messages sms_count="%d" mms_count="%d">\n' % (
        sum(m.kind == 'sms' for m in msgs), sum(m.kind == 'mms' for m in msgs))]
    files, n_mms, k = [], 0, 0
    for m in msgs:
        o = m.o
        if m.kind == 'sms':
            out.append(conv.tag('  ', 'sms', [
                ('address', sval(o, 'address') or ''), ('body', sval(o, 'body') or ''), ('date', sval(o, 'date')),
                ('date_sent', sval(o, 'date_sent') or '0'), ('type', sval(o, 'type')),
                ('read', sval(o, 'read') or '1'), ('seen', sval(o, 'seen') or '1')], m))
            continue
        n_mms += 1
        box = sval(o, 'msg_box')
        out.append(conv.tag('  ', 'mms', [
            ('date', str(m.date_ms // 1000)), ('read', sval(o, 'read') or '1'), ('msg_box', box),
            ('ct_t', sval(o, 'ct_t') or 'application/vnd.wap.multipart.related'),
            ('m_type', sval(o, 'm_type') or ('132' if box == '1' else '128')), ('seen', sval(o, 'seen') or '1')],
            m, end='>'))
        for r in mms_addr_rows(o):
            out.append(conv.tag('    ', 'addr', [('address', sval(r, 'address') or ''),
                                                 ('type', sval(r, 'type') or '151')], m, 'addr.'))
        parts, refs = [], []
        ps = written_parts(o, args)
        for p in ps:
            ct = sval(p, 'ct') or 'application/octet-stream'
            label = sval(p, 'cl') or sval(p, 'name')
            name = part_file(p)
            present = bool(name) and name in src.names
            if name:
                attachment_note(conv, m, p, name, present, src.part_size(name) if present else 0)
            if present:
                k += 1
                fn = 'mms_%d_%d.%s' % (n_mms, k, ext_for(ct, label))
                label = label or fn
                parts.append(conv.tag('    ', 'part', [('ct', ct), ('name', label), ('cl', label), ('file', fn)],
                                      m, 'part.'))
                files.append(('mms_attachments/' + fn, name))
                refs.append((ct, label))
            else:
                attrs = [('ct', sval(p, 'ct') or 'text/plain')]
                if label:
                    attrs += [('name', label), ('cl', label)]
                if sval(p, 'text') is not None:
                    attrs.append(('text', sval(p, 'text')))
                parts.append(conv.tag('    ', 'part', attrs, m, 'part.'))
        if refs and not any(sval(p, 'ct') == 'application/smil' for p in ps):
            parts.insert(0, conv.tag('    ', 'part', [('ct', 'application/smil'), ('name', 'smil.xml'),
                                                     ('cl', 'smil.xml'), ('text', wonder_smil(refs))], m, 'part.'))
        out += parts
        out.append('  </mms>\n')
    out.append('</messages>\n')
    return ''.join(out).encode('utf-8'), files


def write_zip(path, entries, src, now):
    """entries: [(entry name, bytes or the name of a source attachment)]."""
    with open(path, 'wb') as f:
        z = ZipWriter(f, now)
        for name, data in entries:
            z.add(name, data if isinstance(data, bytes) else src.read_part(data))
        z.close()


def verify_zip(path, target, first, files, msgs, src):
    """Re-reads a written ZIP: every entry's CRC-32, the message file byte for byte, every
    attachment by SHA-256, and the messages read back with this converter's own reader."""
    errors, checked = [], 0
    try:
        with zipfile.ZipFile(path) as z:
            bad = z.testzip()
            if bad:
                errors.append('entry %s is damaged (CRC-32 mismatch)' % bad)
            names = z.namelist()
            want = [first[0]] + [n for n, _ in files]
            if names != want:
                errors.append('the ZIP holds %d entries, expected %d' % (len(names), len(want)))
            elif z.read(first[0]) != first[1]:
                errors.append('%s differs from what was written' % first[0])
            else:
                hashes = {}
                for entry, name in files:
                    if name not in hashes:
                        hashes[name] = hashlib.sha256(src.read_part(name)).hexdigest()
                    if hashlib.sha256(z.read(entry)).hexdigest() != hashes[name]:
                        errors.append('attachment %s differs from the source file %s' % (entry, name))
                    else:
                        checked += 1
    except zipfile.BadZipFile as e:
        errors.append('not a readable ZIP file: %s' % e)
    back = collections.Counter()
    if not errors:
        rsrc = open_source(path)
        try:
            rmsgs, rbad, _ = rsrc.load()
            back = collections.Counter(m.kind for m in rmsgs)
            if rbad:
                errors.append('%d record(s) could not be read back' % len(rbad))
        finally:
            rsrc.close()
    want = collections.Counter(m.kind for m in msgs)
    if not errors and back != want:
        errors.append('read back %d SMS + %d MMS, expected %d SMS + %d MMS' % (
            back['sms'], back['mms'], want['sms'], want['mms']))
    return [
        'VERIFICATION (the saved ZIP re-read: every entry\'s CRC-32, the %s byte for byte, every attachment' % (
            'message file' if target == 'fig' else 'XML file'),
        '              by SHA-256, and the messages read back with this converter\'s %s reader)' % TARGET_NAMES[target],
        '  messages read back:       %d SMS + %d MMS (written %d SMS + %d MMS)' % (
            back['sms'], back['mms'], want['sms'], want['mms']),
        '  attachments checked:      %d' % checked,
        '  result: %s' % ('PASSED' if not errors else 'FAILED')] + ['    ! ' + e for e in errors], (1 if errors else 0)


def write_sbr(path, msgs, conv, args, now):
    tmp = path + '.partial'
    with open(tmp, 'w', encoding='utf-8', newline='\n') as f:
        f.write("<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n")
        f.write('<!--Converted by sie_to_sbr.py %s on %s. readable_date values are in %s.-->\n'
                % (VERSION, now.strftime('%Y-%m-%d %H:%M:%S %z'), tz_label(args.tz)))
        f.write('<?xml-stylesheet type="text/xsl" href="sms.xsl"?>\n')
        f.write('<smses count="%d" backup_set="%s" backup_date="%d" type="full">\n'
                % (len(msgs), uuid.uuid4(), int(now.timestamp() * 1000)))
        for m in msgs:
            f.write(conv.sms(m) if m.kind == 'sms' else conv.mms(m))
        f.write('</smses>\n')
    os.replace(tmp, path)


def write_manifest(path, msgs, plan, conv, args):
    with open(path, 'w', encoding='utf-8', newline='') as f:
        w = csv.writer(f)
        w.writerow(['xml_index', 'kind', 'direction', 'source_line', 'source_id', 'source_thread_id',
                    'source_sub_id', 'written_sub_id', 'date_ms', 'date_utc', 'address_written',
                    'parts', 'attachments', 'notes'])
        for i, m in enumerate(msgs, 1):
            o = m.o
            parts = written_parts(o, args) if m.kind == 'mms' else []
            addr = sval(o, 'address') if m.kind == 'sms' else '~'.join(plan.address_list(m))
            w.writerow([i, m.kind, m.direction, m.line, sval(o, '_id'), sval(o, 'thread_id'),
                        sval(o, 'sub_id'), sub_id_for(o, args.sub_id), m.date_ms, utc(m.date_ms),
                        addr, len(parts) if m.kind == 'mms' else '',
                        sum(1 for p in parts if part_file(p)) if m.kind == 'mms' else '',
                        '; '.join(conv.notes.get(m.line, []))])


def describe_filters(args, left_out):
    out = []
    if args.keep == 'sms':
        out.append('text messages (SMS) only, %d MMS left out' % left_out['mms'])
    elif args.keep == 'mms':
        out.append('picture and group messages (MMS) only, %d SMS left out' % left_out['sms'])
    if args.no_groups:
        out.append('%d group MMS left out' % left_out['groups'])
    if args.no_pdf:
        out.append('%d PDF attachment(s) left out' % left_out['pdf'])
    return '; '.join(out) or 'none (everything is kept)'


def cmd_convert(args):
    out_dir = os.path.dirname(os.path.abspath(args.output))
    os.makedirs(out_dir, exist_ok=True)
    src = open_source(args.source, out_dir)
    try:
        return convert_with(src, args)
    finally:
        src.close()


def convert_with(src, args):
    guard_output(src, args.output, args.force, args.to)
    msgs, bad, blank = load(src)
    plan = Plan(msgs, args.owner)
    conv = Converter(src, plan, args)
    problems, ok, chosen, left_out = choose(src, msgs, plan, args)
    groups = split_messages(chosen, src, plan, args)
    stem, ext = os.path.splitext(args.output)
    paths = [args.output] if len(groups) == 1 else ['%s-part%d%s' % (stem, k, ext) for k in range(1, len(groups) + 1)]
    now = dt.datetime.now().astimezone()
    ids = fig_ids(chosen, plan) if args.to == 'fig' else None
    vreport, status, written = [], 0, []
    for k, (path, part) in enumerate(zip(paths, groups), 1):
        if os.path.exists(path) and not args.force:
            sys.exit('error: %s already exists (use --force to replace it)' % path)
        if args.to == 'sbr':
            write_sbr(path, part, conv, args, now)
            lines, st = verify(src, part, plan, args, path)
        else:
            if args.to == 'fig':
                data, files = fig_part(part, src, plan, args, conv, ids)
                first = ('messages.ndjson', data)
            else:
                data, files = wonder_part(part, src, args, conv)
                first = ('Messages_Backup_%s.xml' % now.strftime('%Y-%m-%d'), data)
            write_zip(path + '.partial', [first] + files, src, now)
            os.replace(path + '.partial', path)
            lines, st = verify_zip(path, args.to, first, files, part, src)
        write_manifest(path[:-4] + '.manifest.csv', part, plan, conv, args)
        if len(groups) > 1:
            lines = ['PART %d of %d: %s (%d messages)' % (k, len(groups), os.path.basename(path), len(part))] + lines
        vreport += lines + ['']
        status = status or st
        written.append(path)

    report = source_summary(src, msgs, bad, blank, plan)
    report += ['', 'CONVERSION',
               '  output format:     %s' % TARGET_NAMES[args.to]]
    for path in written:
        report.append('  output:            %s (%s bytes)' % (os.path.abspath(path), format(os.path.getsize(path), ',')))
    if len(written) > 1:
        report.append('  parts:             %d files of at most about %s MB; restore them in order, part 1 first'
                      % (len(written), format(args.split_mb, 'g')))
    report += ['  mode:              %s' % ('test sample (--sample)' if args.sample else 'all messages'),
               '  kept:              %s' % describe_filters(args, left_out),
               '  written:           %d SMS + %d MMS = %d messages' % (
                   sum(m.kind == 'sms' for m in chosen), sum(m.kind == 'mms' for m in chosen), len(chosen)),
               '  attachments:       %d written (%s bytes), %d empty in the export, %d missing from the export' % (
                   conv.stats['attachments'] - conv.stats['attachments_missing'],
                   format(conv.stats['attachment_bytes'], ','), conv.stats['attachments_empty'],
                   conv.stats['attachments_missing']),
               '  not convertible:   %d record(s)%s' % (len(problems) + len(bad), '' if problems or bad else ' (none)')]
    for m, why in problems:
        report.append('    %s %d (%s): %s' % (src.unit, m.line, m.kind, why))
    for line, why in bad:
        report.append('    %s %d: %s' % (src.unit, line, why))
    report += ['  sub_id (SIM):      %s' % {
        'unknown': 'written as -1 ("SIM unknown") for every message; the old phone\'s values are in the manifest',
        'keep': 'the old phone\'s values written unchanged'}.get(args.sub_id, 'written as %s for every message' % args.sub_id),
               '  text changes:      %d field(s) had characters XML cannot store (%s)%s' % (
                   len(conv.changes), 'removed' if args.nul == 'strip' else 'replaced by U+FFFD',
                   '' if conv.changes else ' - none')]
    for line, kind, field, n, chars in conv.changes:
        report.append('    %s %d (%s %s): %d x %s' % (src.unit, line, kind, field, n, '/'.join(chars)))
    if args.to == 'sbr':
        report.append('  MMS whose "address" comes from their conversation (headers list fewer people): %d'
                      % conv.stats['mms_address_from_conversation'])
        for m in chosen:
            if any(n.startswith('MMS headers') for n in conv.notes.get(m.line, [])):
                report.append('    %s %d (thread %s)' % (src.unit, m.line, sval(m.o, 'thread_id')))
    for m in chosen:
        for n in conv.notes.get(m.line, []):
            if 'attachment' in n:
                report.append('    %s %d: %s' % (src.unit, m.line, n))
    report += not_carried(chosen, args)

    print('\n'.join(report))
    print('\n' + '\n'.join(vreport).rstrip())
    report_path = os.path.splitext(args.output)[0] + '.report.txt'
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write('Message backup conversion report (sie_to_sbr.py %s): %s -> %s\n' % (
            VERSION, src.describe.split(':')[0], TARGET_NAMES[args.to]))
        f.write('generated %s\n\n' % now.strftime('%Y-%m-%d %H:%M:%S %z'))
        f.write('\n'.join(report + [''] + vreport).rstrip() + '\n')
    print('\nwrote %s\n      %s' % ('\n      '.join(written), report_path))
    return status


def count_conversations(src, msgs, plan):
    """Old conversations: thread_id values in an SMS Import / Export export; other formats
    have none, so their messages are grouped by participants."""
    if src.format == 'sie':
        return '%d thread_id values' % len({sval(m.o, 'thread_id') for m in msgs})
    return '%d (by participants)' % len({chat_key(plan, m) for m in msgs if not plan.problem(m)})


def source_summary(src, msgs, bad, blank, plan):
    sms = [m for m in msgs if m.kind == 'sms']
    mms = [m for m in msgs if m.kind == 'mms']
    parts = [p for m in mms for p in mms_parts(m.o)]
    refs = [part_file(p) for p in parts if part_file(p)]
    found = [r for r in refs if r in src.names]
    empty = sum(1 for r in found if src.part_size(r) == 0)
    dates = [m.date_ms for m in msgs if m.date_ms]
    count = lambda ms, f: ', '.join('%s %d' % (k, v) for k, v in sorted(collections.Counter(f(m) for m in ms).items()))
    unit = 'lines' if src.unit == 'line' else 'records'
    return [
        'SOURCE',
        '  path:              %s (%s)' % (src.path, src.kind),
        '  format:            %s' % src.describe,
        '  records:           %d %s (%d blank, %d unreadable)' % (len(msgs) + len(bad) + blank, unit, blank, len(bad)),
        '  SMS:               %d (%s)' % (len(sms), count(sms, lambda m: m.direction)),
        '  MMS:               %d (%s)' % (len(mms), count(mms, lambda m: m.direction)),
        '  MMS parts:         %d (%s)' % (len(parts), count(parts, lambda p: 'SMIL' if sval(p, 'ct') == 'application/smil'
                                                                else ('attachment' if part_file(p) else 'text'))),
        '  attachment files:  %d referenced, %d present, %d missing, %d empty (0 bytes); %d file(s) '
        'not referenced by any part' % (len(refs), len(found), len(refs) - len(found), empty,
                                         len(src.names - set(refs))),
        '  conversations:     %s' % count_conversations(src, msgs, plan),
        '  owner number:      %s (from %s)' % (', '.join(mask(k) for k in sorted(plan.owner)) or 'unknown',
                                               plan.owner_how),
        '  dates:             %s .. %s' % (utc(min(dates), '%Y-%m-%d %H:%M UTC'), utc(max(dates), '%Y-%m-%d %H:%M UTC'))
        if dates else '  dates:             none',
        '  SIM sub_id values: %s' % count(msgs, lambda m: str(sval(m.o, 'sub_id'))),
    ]


def not_carried(msgs, args):
    """Source fields with no place in the target format (reported, not hidden)."""
    sub_policy, target = args.sub_id, getattr(args, 'to', 'sbr')
    if target == 'fig':
        known_sms = known_mms = known_part = known_addr = None  # every column is kept
    elif target == 'wonder':
        known_sms = {'address', 'body', 'date', 'date_sent', 'type', 'read', 'seen'}
        known_mms = {'date', 'read', 'msg_box', 'ct_t', 'm_type', 'seen'} | set(K_PARTS + K_SENDER + K_RECIPS)
        known_part, known_addr = {'ct', 'name', 'cl', 'text', '_data'}, {'address', 'type'}
    else:
        known_sms = set(SMS_ORDER) | set(K_NAME)
        known_mms = set(MMS_ORDER) | set(K_PARTS + K_SENDER + K_RECIPS + K_NAME)
        known_part, known_addr = set(PART_ATTRS) | {'_data'}, set(ADDR_ATTRS) | set(K_NAME)
    c = collections.Counter()
    for m in msgs:
        if known_sms is not None:
            if m.kind == 'sms':
                c.update('sms.' + k for k in m.o if k not in known_sms)
            else:
                c.update('mms.' + k for k in m.o if k not in known_mms)
                for p in mms_parts(m.o):
                    c.update('part.' + k for k in p if k not in known_part)
                for r in mms_addr_rows(m.o):
                    c.update('addr.' + k for k in r if k not in known_addr)
        if sub_policy != 'keep' and sval(m.o, 'sub_id') is not None:
            c['%s.sub_id (old phone value)' % m.kind] += 1
    lines = ['  source fields not stored in the %s (no matching field in its format,' % (
             'XML' if target != 'fig' else 'ZIP'),
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
    for p in written_parts(o, args):
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


def verify(src, candidates, plan, args, path):
    """Re-read the XML with a strict parser and match every element to the source record
    it was written from; candidates are the messages the file is meant to hold."""
    tz = get_tz(args.tz)
    out, errors = [], []
    expected = collections.defaultdict(list)
    hashes = {}
    for m in candidates:
        key = expected_sms(m, args) if m.kind == 'sms' else expected_mms(m, args, src, hashes)
        expected[key].append(m)

    with open(path, 'rb') as f:
        head = f.read(200)
    if not head.startswith(b"<?xml version='1.0' encoding='UTF-8'"):
        errors.append('the file does not start with the XML declaration SMS Backup & Restore writes')

    matched, unmatched, n_sms, n_mms, root_attrs = [], [], 0, 0, {}
    bad_dates, bad_names, bad_tags = 0, 0, collections.Counter()
    root = None
    try:
        for event, el in ET.iterparse(path, events=('start', 'end')):
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
    if left:
        errors.append('%d source message(s) are missing from the XML, e.g. %ss %s'
                      % (len(left), src.unit, [m.line for m in left[:5]]))
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
    split = {t: ks for t, ks in by_thread.items() if len(ks) > 1 and t is not None}
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
            '  conversations predicted after restore: %d%s' % (
                len(owners), ' (from %d old thread_id values)' % len(by_thread) if src.format == 'sie' else '')]
    for t, ks in sorted(split.items(), key=lambda x: str(x[0])):
        out.append('    old thread %s will appear as %d conversations: %s' % (
            t, len(ks), ' + '.join('[%s]' % ', '.join(mask(x) for x in sorted(k)) if len(k) < 4
                                   else '[%d people]' % len(k) for k in ks)))
    for k, ts in merged.items() if src.format == 'sie' else ():
        out.append('    old threads %s will share one conversation [%s]' % (
            sorted(ts, key=str), ', '.join(mask(x) for x in sorted(k))))
    out.append('  result: %s' % ('PASSED' if not errors else 'FAILED'))
    out += ['    ! ' + e for e in errors]
    return out, (0 if not errors else 1)


def cmd_verify(args):
    """Checks an SMS Backup & Restore file made from SOURCE with the same options (by any
    of the three versions of this converter)."""
    if not args.output.lower().endswith('.xml'):
        sys.exit('error: verify checks SMS Backup & Restore .xml files')
    src = open_source(args.source)
    try:
        msgs, bad, blank = load(src)
        plan = Plan(msgs, args.owner)
        report, status = verify(src, choose(src, msgs, plan, args)[2], plan, args, args.output)
        print('\n'.join(report))
        return status
    finally:
        src.close()


def cmd_analyze(args):
    src = open_source(args.source)
    try:
        msgs, bad, blank = load(src)
        plan = Plan(msgs, args.owner)
        args.sub_id, args.to = 'keep', 'sbr'
        print('\n'.join(source_summary(src, msgs, bad, blank, plan) + not_carried(msgs, args)))
        for m in msgs:
            if plan.problem(m):
                print('  not convertible: %s %d (%s): %s' % (src.unit, m.line, m.kind, plan.problem(m)))
        for line, why in bad:
            print('  unreadable: %s %d: %s' % (src.unit, line, why))
        return 0
    finally:
        src.close()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    sub = ap.add_subparsers(dest='command', required=True)
    for name in ('analyze', 'convert', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('source', help='the backup: a .zip or .xml file, or the folder an SMS Import / Export '
                                      'export was extracted to')
        if name != 'analyze':
            p.add_argument('output', help='the file to write / check, e.g. sms-20261005120000.xml')
            p.add_argument('--sample', action='store_true',
                           help='write only a small representative test set')
            p.add_argument('--keep', choices=('all', 'sms', 'mms'), default='all',
                           help='which messages to write: all (default), only text messages (sms), or only '
                                'picture and group messages (mms)')
            p.add_argument('--no-groups', action='store_true', help='leave out group conversations (MMS)')
            p.add_argument('--no-pdf', action='store_true', help='leave out PDF attachments')
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
            p.add_argument('--to', choices=TARGETS, default='sbr',
                           help='the format to write: sbr (SMS Backup & Restore XML, default), fig (Fig / TAK: '
                                'an SMS Import / Export ZIP) or wonder (a Wonder ZIP)')
            p.add_argument('--split-mb', type=float, default=0,
                           help='write outputs bigger than this many MB as several files (part1, part2, ...) '
                                'to restore in order; 0 (default) writes one file')
            p.add_argument('--force', action='store_true', help='replace existing output files')
    args = ap.parse_args()
    if getattr(args, 'sub_id', 'unknown') not in ('unknown', 'keep') and not is_int(args.sub_id):
        ap.error('--sub-id must be "unknown", "keep" or a number')
    if args.command == 'verify':
        args.to, args.split_mb = 'sbr', 0
    return {'analyze': cmd_analyze, 'convert': cmd_convert, 'verify': cmd_verify}[args.command](args)


if __name__ == '__main__':
    sys.exit(main())
