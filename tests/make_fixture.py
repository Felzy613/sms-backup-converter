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
with everything inside a parent folder.
"""

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
    print('fixture written to', outdir)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(__file__), 'output'))
