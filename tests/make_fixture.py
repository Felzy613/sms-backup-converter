#!/usr/bin/env python3
"""Build a synthetic SMS Import / Export export for the tests.

Everything here is made up: 555-01xx numbers are reserved for fiction and the names
are invented. The records cover the cases the converter has to get right: group
chats, a conversation with yourself, MMS headers that list fewer people than their
group, empty and missing attachments, characters XML cannot store, emoji, line
breaks, a "group SMS" with several numbers in one address, unconvertible records,
and lines that are not valid JSON.

  python3 tests/make_fixture.py OUTPUT_DIR

writes OUTPUT_DIR/messages-2026-01-15/ (the extracted folder) and three ZIP files of
it: deflated, written with data descriptors (as Android's ZipOutputStream does), and
with everything inside a parent folder. It also writes backups in the other formats the
converter reads, each with its own tricky cases: sbr-2026-01-15.xml (SMS Backup &
Restore) and sbr-zipped.zip, wonder-2026-01-15.zip, pom-2026-01-15.zip and
buggy-2026-01-15.zip.
"""

import base64

import io
import json
import os
import random
import shutil
import struct
import sys
import zipfile
import zlib

OWNER = '+15550100100'
ALEX, BEA, CAM = '+15550100201', '+15550100202', '+15550100203'
NAMES = {OWNER: 'Me', ALEX: 'Alex Example', BEA: 'Bea Sample', CAM: 'Cam Test'}
APP_PARTS = '/data/user_de/0/com.android.providers.telephony/app_parts/'
T0 = 1767225600  # 2026-01-01 00:00:00 UTC

rng = random.Random(613)
files = {}        # data/ file name -> bytes
counter = [9000]  # row ids for addr and part rows


def next_id():
    counter[0] += 1
    return str(counter[0])


def png(width, height, rgb):
    def chunk(kind, data):
        body = kind + data
        return struct.pack('>I', len(data)) + body + struct.pack('>I', zlib.crc32(body) & 0xffffffff)
    raw = b''.join(b'\x00' + bytes(rgb) * width for _ in range(height))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) +
            chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


def attachment(name, data):
    files[name] = data
    return APP_PARTS + name


def sms(_id, thread, address, body, kind, minutes, name=None, **extra):
    o = {'_id': str(_id), 'thread_id': thread, 'address': address, 'body': body, 'date': str((T0 + minutes * 60) * 1000 + 123),
         'date_sent': str((T0 + minutes * 60 - 5) * 1000) if kind == '1' else '0', 'read': '1', 'seen': '1',
         'status': '-1' if kind == '1' else '0', 'sub_id': '1', 'type': kind}
    if name:
        o['__display_name'] = name
    o.update(extra)
    return o


def addr(address, kind, mid):
    o = {'_id': next_id(), 'address': address, 'charset': '106', 'msg_id': mid, 'type': kind}
    if address in NAMES:
        o['__display_name'] = NAMES[address]
    return o


def part(mid, ct, seq='0', text=None, data=None, **extra):
    o = {'_id': next_id(), 'ct': ct, 'mid': mid, 'seq': seq}
    if text is not None:
        o['text'] = text
    if data is not None:
        o['_data'] = data
    o.update(extra)
    return o


def smil(mid, *refs):
    body = ''.join('<par dur="5000ms"><%s src="%s" region="%s"/></par>' % r for r in refs)
    return part(mid, 'application/smil', '-1', '<smil><head><layout><root-layout/></layout></head><body>%s</body></smil>' % body,
                cid='<smil>', cl='smil.xml', name='smil.xml')


def mms(_id, thread, box, sender, recipients, minutes, parts, **extra):
    mid = str(_id)
    o = {'_id': mid, 'thread_id': thread, 'date': str(T0 + minutes * 60), 'date_sent': '0', 'read': '1', 'seen': '1',
         'sub_id': '2', 'ct_t': 'application/vnd.wap.multipart.related', 'msg_box': box,
         'm_type': '132' if box == '1' else '128', 'tr_id': 'T%08x' % (int(mid) * 7919), 'm_id': 'MID%06d' % int(mid),
         'd_rpt': '129', 'rr': '129', 'm_cls': 'personal', 'pri': '129'}
    if box == '2':
        o['resp_st'] = '128'
    o['__sender_address'] = addr(sender, '137', mid)
    o['__recipient_addresses'] = [addr(a, '151', mid) for a in recipients]
    o['__parts'] = parts(mid)
    o.update(extra)
    return o


def text_part(text, n=0):
    return lambda mid: [smil(mid, ('text', 'text%d.txt' % n, 'Text')),
                        part(mid, 'text/plain', text=text, chset='106', cid='<text%d>' % n, cl='text%d.txt' % n, name='text%d.txt' % n)]


def records():
    out = []
    # A one-to-one conversation with SMS and MMS in both directions (thread 1).
    out.append(sms(1, '1', ALEX, 'Hi there', '1', 10, NAMES[ALEX]))
    out.append(sms(2, '1', '5550100201', 'Line one\nLine two', '2', 11))
    out.append(sms(3, '1', ALEX, 'Dinner? \U0001F355\U0001F389', '1', 12, NAMES[ALEX]))
    out.append(sms(4, '1', ALEX, 'Tom & Jerry <3 "quotes" \'apostrophes\'', '2', 13))
    out.append(sms(5, '1', ALEX, 'a\r\nb\tc', '1', 14, NAMES[ALEX]))
    out.append(sms(6, '1', ALEX, '  spaced out  ', '1', 15, NAMES[ALEX]))
    out.append(sms(7, '1', ALEX, 'abc\x00def\x00', '1', 16, NAMES[ALEX]))
    out.append(sms(8, '1', ALEX, '\ud83d broken emoji', '1', 17, NAMES[ALEX]))
    for i in range(9, 21):
        out.append(sms(i, '1', ALEX, 'Message number %d' % i, '2' if i % 3 else '1', 20 + i, NAMES[ALEX] if i % 3 == 0 else None))
    out.append(mms(101, '1', '1', ALEX, [OWNER], 40, lambda mid: [
        smil(mid, ('img', 'image0.png', 'Image'), ('text', 'text0.txt', 'Text')),
        part(mid, 'image/png', data=attachment('PART_1767225600001', png(4, 3, (200, 40, 40))), cid='<image0>', cl='image0.png', name='image0.png'),
        part(mid, 'text/plain', text='Look at this', chset='106', cid='<text0>', cl='text0.txt', name='text0.txt')]))
    out.append(mms(102, '1', '2', OWNER, [ALEX], 41, lambda mid: [
        smil(mid, ('img', 'IMG_0001.jpg', 'Image')),
        part(mid, 'image/jpeg', data=attachment('PART_1767225600002', bytes(rng.randrange(256) for _ in range(5000))),
             cid='<IMG_0001>', cl='IMG_0001.jpg', name='IMG_0001.jpg', cd='attachment')]))
    out.append(mms(103, '1', '2', 'insert-address-token', [ALEX], 42, text_part('Sent from the old app')))

    # A different number format for another contact (thread 2) and other senders.
    out.append(sms(30, '2', '(555) 010-0202', 'Formatted number', '1', 50, NAMES[BEA]))
    out.append(sms(31, '2', '+1 555-010-0202', 'Same person, other format', '2', 51))
    out.append(sms(32, '3', '72975', 'STOP', '2', 52))
    out.append(sms(33, '4', 'Google', 'G-123456 is your code', '1', 53))
    out.append(sms(34, '6', '5550100204', 'null', '1', 54))
    out.append(sms(35, '7', '5550100205', 'Extra columns', '1', 55, protocol='0', locked='1',
                   service_center='+15550100999', error_code='0', reply_path_present='0'))
    out.append(dict(sms(36, '7', '5550100205', 'Numbers instead of strings', '1', 56), read=1, sub_id=-1))

    # A group conversation (thread 5).
    out.append(mms(201, '5', '1', BEA, [OWNER, ALEX, CAM], 60, text_part('Group hello')))
    out.append(mms(202, '5', '1', CAM, [OWNER, ALEX, BEA], 61, lambda mid: [
        smil(mid, ('img', 'photo.png', 'Image')),
        part(mid, 'image/png', data=attachment('PART_1767225600003', png(2, 2, (40, 160, 40))), cid='<photo>', cl='photo.png', name='photo.png'),
        part(mid, 'text/x-vCard', data=attachment('PART_1767225600004', b'BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Dee Demo\r\nTEL:+15550100206\r\nEND:VCARD\r\n'),
             cid='<contact>', cl='contact.vcf', name='contact.vcf')]))
    out.append(mms(203, '5', '2', OWNER, [ALEX, BEA, CAM], 62, text_part('Reply to all')))
    out.append(mms(204, '5', '1', ALEX, [OWNER, BEA], 63, text_part('Headers miss Cam')))
    out.append(sms(37, '5', ' '.join([ALEX, BEA, CAM]), 'Group text sent as SMS', '2', 64))
    rows = mms(205, '5', '1', CAM, [BEA, OWNER, ALEX], 65, text_part('Unsorted address rows'))
    a, b, c = rows['__recipient_addresses']
    a['_id'], b['_id'], c['_id'] = '9997', '9995', '9996'
    out.append(rows)

    # Notes to self (thread 9).
    out.append(sms(38, '9', OWNER, 'Note to self', '2', 70))
    out.append(mms(301, '9', '2', OWNER, [OWNER], 71, text_part('Picture note to self')))

    # Attachments: empty file, missing file, subject and other header fields.
    out.append(mms(401, '1', '2', OWNER, [ALEX], 80, lambda mid: [
        smil(mid, ('img', 'empty.jpg', 'Image')),
        part(mid, 'image/jpeg', data=attachment('PART_1767225600005', b''), cid='<empty>', cl='empty.jpg')]))
    out.append(mms(402, '1', '1', ALEX, [OWNER], 81, lambda mid: [
        smil(mid, ('audio', 'voice.amr', 'Audio')),
        part(mid, 'audio/amr', data=APP_PARTS + 'PART_1767225600999', cid='<voice>', cl='voice.amr')]))
    out.append(mms(403, '1', '1', ALEX, [OWNER], 82, text_part('With a subject', 1), sub='Weekend plans', sub_cs='106',
                   retr_st='128', ct_t='application/vnd.wap.multipart.mixed'))
    out.append(mms(404, '1', '1', ALEX, [OWNER], 83, text_part('Vertical\x0btab in an MMS text')))
    out.append(mms(405, '1', '1', ALEX, [OWNER], 0, text_part('Date already in milliseconds'), date=str((T0 + 84 * 60) * 1000)))
    no_thread = mms(406, '1', '1', CAM, [OWNER], 85, text_part('No thread id'))
    del no_thread['thread_id']
    out.append(no_thread)
    out.append(mms(407, '1', '1', ALEX, [OWNER], 86, lambda mid: [smil(mid)]))

    # Records that cannot be converted.
    draft = sms(90, '1', ALEX, 'Draft without address', '3', 90)
    del draft['address']
    out.append(draft)
    out.append(dict(sms(91, '1', ALEX, 'Bad date', '1', 91), date='yesterday'))
    no_box = mms(501, '1', '1', ALEX, [OWNER], 92, text_part('No msg_box'))
    del no_box['msg_box']
    out.append(no_box)
    nobody = mms(502, '10', '1', ALEX, [OWNER], 93, text_part('No addresses'))
    nobody['__sender_address'], nobody['__recipient_addresses'] = None, []
    out.append(nobody)
    return out


def main(outdir):
    folder = os.path.join(outdir, 'messages-2026-01-15')
    shutil.rmtree(folder, ignore_errors=True)
    os.makedirs(os.path.join(folder, 'data'))
    lines = []
    for i, r in enumerate(records()):
        text = json.dumps(r, ensure_ascii=bool(i % 2))
        try:
            lines.append(text.encode('utf-8'))
        except UnicodeEncodeError:  # a lone surrogate: keep it as a \udXXX escape
            lines.append(json.dumps(r).encode('ascii'))
    lines.insert(5, b'')                                      # a blank line
    lines.insert(9, b'{"_id": "999", "body": broken json')    # not JSON
    lines.insert(12, b'["an", "array"]')                      # not an object
    lines.insert(14, b'{"something": "else"}')                # neither SMS nor MMS
    lines.insert(16, b'{"_id": "998", "body": "bad \xff byte"}')  # not UTF-8
    with open(os.path.join(folder, 'messages.ndjson'), 'wb') as f:
        f.write(b'\n'.join(lines) + b'\n')
    files['PART_1767225600777'] = b'not referenced by any message'
    for name, data in files.items():
        with open(os.path.join(folder, 'data', name), 'wb') as f:
            f.write(data)

    def add_all(z, prefix=''):
        z.write(os.path.join(folder, 'messages.ndjson'), prefix + 'messages.ndjson')
        for name in sorted(os.listdir(os.path.join(folder, 'data'))):
            z.write(os.path.join(folder, 'data', name), prefix + 'data/' + name)

    with zipfile.ZipFile(folder + '.zip', 'w', zipfile.ZIP_DEFLATED) as z:
        add_all(z)
    with zipfile.ZipFile(os.path.join(outdir, 'messages-prefixed.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        add_all(z, 'messages-2026-01-15/')

    class Unseekable(io.RawIOBase):  # makes zipfile write data descriptors, like ZipOutputStream
        def __init__(self, f):
            self.f = f
        def writable(self):
            return True
        def write(self, b):
            return self.f.write(b)
    with open(os.path.join(outdir, 'messages-descriptors.zip'), 'wb') as raw:
        with zipfile.ZipFile(Unseekable(raw), 'w', zipfile.ZIP_DEFLATED) as z:
            add_all(z)
    other_formats(outdir)
    print('fixture written to', outdir)


def ms(minutes):
    return str((T0 + minutes * 60) * 1000)


def b64(data):
    return base64.b64encode(data).decode('ascii')


PDF = b'%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'
SMIL = ('&lt;smil&gt;&lt;body&gt;&lt;par dur=&quot;5000ms&quot;&gt;&lt;img src=&quot;image0.png&quot; '
        'region=&quot;Image&quot;/&gt;&lt;/par&gt;&lt;/body&gt;&lt;/smil&gt;')


def sbr_xml():
    """An SMS Backup & Restore file written by hand, with the XML features a real one may
    use: entities, character references, single-quoted attributes, a literal line break
    inside an attribute (which XML turns into a space), comments, "null" values."""
    image = b64(png(3, 2, (10, 20, 200)))
    return (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n"
        "<!--File Created By SMS Backup & Restore (made-up test data)-->\n"
        '<?xml-stylesheet type="text/xsl" href="sms.xsl"?>\n'
        '<smses count="13" backup_set="00000000-0000-4000-8000-000000000000" backup_date="1768478400000" type="full">\n'
        '  <sms protocol="0" address="+15550100201" date="%s" type="1" subject="null" body="Hi from SBR &amp; friends &lt;3" '
        'toa="null" sc_toa="null" service_center="null" read="1" status="-1" locked="0" date_sent="%s" sub_id="3" '
        'readable_date="Jan 1, 2026 12:10:00 AM" contact_name="Alex Example" />\n'
        '  <sms protocol="0" address="+15550100201" date="%s" type="2" subject="null" body="Line one&#10;Line two&#13;&#10;three" '
        'toa="null" sc_toa="null" service_center="null" read="1" status="0" locked="0" date_sent="0" sub_id="3" '
        'readable_date="Jan 1, 2026 12:11:00 AM" contact_name="(Unknown)" />\n'
        "  <sms address='5550100201' date='%s' type='1' body='single \"quoted\" attribute' read='1' status='-1' "
        "contact_name='Alex Example' />\n"
        '  <sms address="+15550100202" date="%s" type="1" body="literal\nline break and\ttab" read="0" status="-1" '
        'contact_name="Bea Sample" />\n'
        '  <!-- a comment between messages -->\n'
        '  <sms address="+15550100202" date="%s" type="2" body="emoji &#x1F600; and &#128512; &apos;x&apos;" read="1" />\n'
        '  <sms address="5550100204" date="%s" type="1" body="null" read="1" status="-1" contact_name="null" />\n'
        '  <sms address="72975" date="%s" type="2" body="no read or status" />\n'
        '  <mms date="%s" rr="null" sub="null" ct_t="application/vnd.wap.multipart.related" read_status="null" seen="1" '
        'msg_box="1" address="+15550100201" sub_cs="null" resp_st="null" retr_st="null" d_tm="null" text_only="0" '
        'exp="604800" locked="0" m_id="SBRMID1" st="null" retr_txt_cs="null" retr_txt="null" date_sent="0" read="1" '
        'm_size="1234" rpt_a="null" ct_cls="null" pri="129" sub_id="3" tr_id="SBRTR1" resp_txt="null" ct_l="null" '
        'm_cls="personal" d_rpt="129" v="18" m_type="132" readable_date="Jan 1, 2026 12:40:00 AM" contact_name="Alex Example">\n'
        '    <parts>\n'
        '      <part seq="-1" ct="application/smil" name="smil.xml" chset="106" cd="null" fn="null" cid="&lt;smil&gt;" '
        'cl="smil.xml" ctt_s="null" ctt_t="null" text="%s" />\n'
        '      <part seq="0" ct="image/png" name="image0.png" chset="null" cd="null" fn="null" cid="&lt;image0&gt;" '
        'cl="image0.png" ctt_s="null" ctt_t="null" text="null" data="%s" />\n'
        '      <part seq="0" ct="text/plain" name="text0.txt" chset="106" cd="null" fn="null" cid="&lt;text0&gt;" '
        'cl="text0.txt" ctt_s="null" ctt_t="null" text="Look at this" />\n'
        '    </parts>\n'
        '    <addrs>\n'
        '      <addr address="+15550100201" type="137" charset="106" />\n'
        '      <addr address="+15550100100" type="151" charset="106" />\n'
        '    </addrs>\n'
        '  </mms>\n'
        '  <mms date="%s" msg_box="2" m_type="128" read="1" seen="1" ct_t="application/vnd.wap.multipart.related" sub_id="3" '
        'address="+15550100201~+15550100202~+15550100203" contact_name="Alex Example, Bea Sample, Cam Test">\n'
        '    <parts>\n'
        '      <part seq="0" ct="text/plain" name="null" chset="106" cd="null" fn="null" cid="null" cl="null" ctt_s="null" '
        'ctt_t="null" text="Group reply from SBR" />\n'
        '    </parts>\n'
        '    <addrs>\n'
        '      <addr address="+15550100202" type="151" charset="106" />\n'
        '      <addr address="+15550100100" type="137" charset="106" />\n'
        '      <addr address="+15550100201" type="151" charset="106" />\n'
        '      <addr address="+15550100203" type="151" charset="106" />\n'
        '    </addrs>\n'
        '  </mms>\n'
        '  <mms date="%s" msg_box="1" m_type="132" read="1" ct_t="application/vnd.wap.multipart.mixed" sub="Forms">\n'
        '    <parts>\n'
        '      <part seq="0" ct="application/pdf" name="form.pdf" cl="form.pdf" text="null" data="%s" />\n'
        '      <part seq="0" ct="text/plain" text="The form, as a PDF" />\n'
        '      <part seq="0" ct="image/jpeg" cl="empty.jpg" text="null" data="" />\n'
        '      <part seq="0" ct="image/jpeg" cl="broken.jpg" text="null" data="!!not base64!!" />\n'
        '      <part seq="0" ct="image/png" cl="wrapped.png" text="null" data="%s" />\n'
        '    </parts>\n'
        '    <addrs>\n'
        '      <addr address="+15550100203" type="137" charset="106" />\n'
        '      <addr address="+15550100100" type="151" charset="106" />\n'
        '    </addrs>\n'
        '  </mms>\n'
        '</smses>\n') % (ms(10), ms(9), ms(11), ms(12), ms(13), ms(14), ms(15), ms(16), ms(40), SMIL, image, ms(41),
                          ms(42), b64(PDF), '&#10;'.join(image[i:i + 20] for i in range(0, len(image), 20)))


def wonder_xml():
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<messages sms_count="3" mms_count="3">\n'
        '  <sms address="+15550100201" body="Hello from Wonder" date="%s" date_sent="0" type="1" read="1" seen="1" />\n'
        '  <sms address="+15550100201" body="Reply &amp; more&#10;on two lines" date="%s" type="2" read="1" />\n'
        '  <sms address="+15550100205" body="" date="%s" type="1" read="0" seen="0" />\n'
        '  <mms date="%d" read="1" msg_box="1" ct_t="application/vnd.wap.multipart.related" m_type="132" seen="1">\n'
        '    <addr address="+15550100201" type="137" />\n'
        '    <addr address="+15550100100" type="151" />\n'
        '    <part ct="application/smil" name="smil.xml" cl="smil.xml" text="%s" />\n'
        '    <part ct="image/jpeg" name="photo.jpg" cl="photo.jpg" file="mms_1_1.jpg" />\n'
        '    <part ct="text/plain" text="Wonder picture" />\n'
        '  </mms>\n'
        '  <mms date="%d" read="1" msg_box="2" m_type="128" seen="1">\n'
        '    <addr address="+15550100100" type="137" />\n'
        '    <addr address="+15550100201" type="151" />\n'
        '    <addr address="+15550100202" type="151" />\n'
        '    <addr address="+15550100203" type="151" />\n'
        '    <part ct="text/plain" text="Wonder group" />\n'
        '  </mms>\n'
        '  <mms date="%d" read="0" msg_box="1" m_type="132">\n'
        '    <addr address="+15550100203" type="137" />\n'
        '    <addr address="+15550100100" type="151" />\n'
        '    <part ct="image/jpeg" cl="lost.jpg" file="mms_3_9.jpg" />\n'
        '    <part ct="application/pdf" cl="menu.pdf" file="mms_3_2.pdf" />\n'
        '    <part ct="text/plain" text="Missing photo, and a PDF" />\n'
        '  </mms>\n'
        '</messages>\n') % (ms(100), ms(101), ms(102), T0 + 103 * 60, SMIL, T0 + 104 * 60, T0 + 105 * 60)


def pom_files():
    sms_xml = (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<smses count=\"2\">\n"
        '  <sms protocol="0" address="+15550100201" date="%s" type="1" subject="null" body="Pom text &amp; more" '
        'service_center="null" read="1" status="-1" locked="0" date_sent="0" toa="null" sc_toa="null" '
        'readable_date="null" contact_name="null" />\n'
        '  <sms protocol="0" address="+15550100201" date="%s" type="2" subject="null" body="Pom reply" '
        'service_center="null" read="1" status="0" locked="0" date_sent="0" toa="null" sc_toa="null" '
        'readable_date="null" contact_name="Alex Example" />\n'
        '</smses>\n') % (ms(200), ms(201))
    mms_xml = (
        "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n<mmses count=\"2\">\n"
        '  <mms date="%d" msg_box="1" ct_t="application/vnd.wap.multipart.related" m_type="132" read="1" seen="1" '
        'm_id="null" tr_id="POMTR1" sub_id="2">\n'
        '    <addr address="+15550100201/TYPE=PLMN" type="137" charset="106" />\n'
        '    <addr address="+15550100100/TYPE=PLMN" type="151" charset="106" />\n'
        '    <part seq="0" ct="image/png" name="pic.png" cl="pic.png" text="null" _data_b64="%s" />\n'
        '    <part seq="0" ct="text/plain" name="null" text="Pom picture" _data_b64="null" />\n'
        '  </mms>\n'
        '  <mms date="%d" msg_box="2" m_type="128" read="1" seen="1">\n'
        '    <r address="+15550100201" />\n'
        '    <part ct="text/plain" text="Pom sent, recipients only" />\n'
        '  </mms>\n'
        '</mmses>\n') % (T0 + 202 * 60, b64(png(2, 3, (240, 200, 0))), T0 + 203 * 60)
    return sms_xml, mms_xml


def buggy_entries():
    return [
        ('conversations/', None),
        ('conversations/conv_1', {'q': '+15550100201', 'r': 'Buggy hello', 'm': (T0 + 300 * 60) * 1000,
                                  'n': (T0 + 300 * 60 - 5) * 1000, 'h': 1, 'b': True, 'k': 0, 'g': -1, 'd': False,
                                  'l': 1, 'o': 'com.example.buggy', 'e': True, 'z': 'a key nobody knows'}),
        ('conversations/conv_10', {'q': '+15550100202', 'r': 'Buggy tenth (sorted after conv_2)',
                                   'm': (T0 + 310 * 60) * 1000, 'h': 1, 'b': False}),
        ('conversations/conv_2', {'q': '+15550100201', 'r': 'Buggy reply \U0001F44D', 'm': str((T0 + 302 * 60) * 1000),
                                  'h': 2, 'b': True, 'd': True}),
        ('conversations/conv_3', '{broken'),
        ('conversations/conv_4', {'x': 1}),
    ]


def other_formats(outdir):
    xml = sbr_xml()
    with open(os.path.join(outdir, 'sbr-2026-01-15.xml'), 'w', encoding='utf-8', newline='') as f:
        f.write(xml)
    with zipfile.ZipFile(os.path.join(outdir, 'sbr-zipped.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('sms-20260115120000.xml', xml.encode('utf-8'))
    with zipfile.ZipFile(os.path.join(outdir, 'wonder-2026-01-15.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('Messages_Backup_2026-01-15.xml', wonder_xml().encode('utf-8'))
        z.writestr('mms_attachments/mms_1_1.jpg', bytes(rng.randrange(256) for _ in range(3000)))
        z.writestr('mms_attachments/mms_3_2.pdf', PDF)
    sms_xml, mms_xml = pom_files()
    with zipfile.ZipFile(os.path.join(outdir, 'pom-2026-01-15.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('_pom_backup_manifest.json', '{"version": 1, "note": "made-up test data"}')
        z.writestr('sms.xml', sms_xml.encode('utf-8'))
        z.writestr('mms.xml', mms_xml.encode('utf-8'))
    with zipfile.ZipFile(os.path.join(outdir, 'buggy-2026-01-15.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for name, obj in buggy_entries():
            if obj is None:
                z.writestr(name, b'')
            else:
                z.writestr(name, (obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)).encode('utf-8'))


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'output'))
