#!/usr/bin/env python3
"""Test suite: python3 tests/test_all.py   (needs Python 3.9+ and Node 20+)

1. Builds a synthetic export (tests/make_fixture.py; all data is made up).
2. Converts it with the Python CLI, the browser engine (under Node) and the Android app's
   engine (android/core, built with JDK 17 to 24; skipped with a notice when there is none),
   for four source layouts and several option sets, and requires byte-identical XML and
   manifests, a passing self-check, and the Python verifier passing the other engines'
   output.
3. Checks specific results in the XML against hand-written expectations.
4. Does the same for the other formats: SMS Backup & Restore, Wonder, Pom and Buggy Backup
   backups (also made up) converted to every output format (SMS Backup & Restore, Fig /
   TAK, Wonder) with several option sets, including the "what to keep" options and
   splitting into parts; then checks each format's tricky cases, a round trip through the
   Fig / TAK format, and that splitting loses nothing.
5. Runs the ZIP reader's unit tests (ZIP64, stored entries, damage detection, CP437).
Output goes to tests/output/ (ignored by git).
"""

import json
import os
import re
import shutil
import subprocess
import sys
import zipfile
import xml.etree.ElementTree as ET

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'output')
CLI = os.path.join(ROOT, 'cli', 'sie_to_sbr.py')
RUN_JS = os.path.join(HERE, 'run_js.mjs')
ANDROID = os.path.join(ROOT, 'android')
KT_JAR = os.path.join(ANDROID, 'core', 'build', 'libs', 'sie-cli.jar')
TZ = ['--tz', 'America/New_York']
T0 = 1767225600
failures = []


def check(ok, what):
    print(('  ok   ' if ok else '  FAIL ') + what)
    if not ok:
        failures.append(what)


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True)


def same_xml(a, b):
    la = open(a, encoding='utf-8').read().split('\n')
    lb = open(b, encoding='utf-8').read().split('\n')
    root = lambda s: re.sub(r'backup_set="[^"]*" backup_date="[0-9]+"', '', s)
    return la[0] == lb[0] and la[2] == lb[2] and root(la[3]) == root(lb[3]) and la[4:] == lb[4:]


def build_jdk():
    """A JDK home that can build the Android engine (Java 17 to 24: the Gradle and Kotlin
    versions used cannot run on newer ones), or None. Looks at JAVA_HOME, macOS's
    java_home and the usual Homebrew and Linux locations."""
    homes = [os.environ.get('JAVA_HOME')]
    if os.path.exists('/usr/libexec/java_home'):
        homes += [run(['/usr/libexec/java_home', '-v', v]).stdout.strip() for v in ('21', '17')]
    homes += ['/opt/homebrew/opt/openjdk@21', '/opt/homebrew/opt/openjdk@17', '/usr/local/opt/openjdk@21',
              '/usr/local/opt/openjdk@17', '/opt/homebrew/opt/openjdk', '/usr/lib/jvm/default-java']
    for home in filter(None, homes):
        java = os.path.join(home, 'bin', 'java')
        if os.path.exists(java):
            m = re.search(r'version "(\d+)', run([java, '-version']).stderr)
            if m and 17 <= int(m.group(1)) <= 24:
                return home
    return None


def kotlin_engine():
    """The command to run the Android app's engine, or None if it cannot be built here."""
    home = build_jdk()
    if not home:
        print('  skip Android engine: no JDK 17 to 24 found (set JAVA_HOME to test it)')
        return None
    gradlew = os.path.join(ANDROID, 'gradlew.bat' if os.name == 'nt' else 'gradlew')
    r = subprocess.run([gradlew, '-q', ':core:cliJar'], cwd=ANDROID, capture_output=True, text=True,
                       env=dict(os.environ, JAVA_HOME=home))
    if r.returncode or not os.path.exists(KT_JAR):
        check(False, 'the Android engine builds: ' + (r.stdout + r.stderr)[-1500:])
        return None
    return [os.path.join(home, 'bin', 'java'), '-jar', KT_JAR]


def equivalence(kt_cmd):
    print('Python CLI vs browser engine vs Android engine (byte-identical XML and manifest, all verified):')
    sources = {'folder': 'messages-2026-01-15', 'zip': 'messages-2026-01-15.zip',
               'zip with data descriptors': 'messages-descriptors.zip', 'zip inside a folder': 'messages-prefixed.zip'}
    option_sets = {'default': [], 'test sample': ['--sample'], 'keep SIM ids': ['--sub-id', 'keep'],
                   'SIM id 3, replace characters': ['--sub-id', '3', '--nul', 'replace'],
                   'owner given': ['--owner', '+1 (555) 010-0100']}
    for sname, src in sources.items():
        for oname, opts in option_sets.items():
            src_path = os.path.join(OUT, src)
            tag = re.sub(r'\W+', '-', sname + '-' + oname)
            py, js = os.path.join(OUT, 'py-%s.xml' % tag), os.path.join(OUT, 'js-%s.xml' % tag)
            a = run([sys.executable, CLI, 'convert', src_path, py, '--force'] + opts + TZ)
            b = run(['node', RUN_JS, src_path, js] + opts + TZ)
            c = run([sys.executable, CLI, 'verify', src_path, js] + opts + TZ) if b.returncode == 0 else b
            ok = (a.returncode == 0 and b.returncode == 0 and c.returncode == 0 and same_xml(py, js) and
                  open(py[:-4] + '.manifest.csv', 'rb').read() == open(js[:-4] + '.manifest.csv', 'rb').read())
            check(ok, '%s, %s' % (sname, oname))
            if not ok:
                print('\n'.join(x.stdout[-1500:] + x.stderr[-1500:] for x in (a, b, c)))
            if kt_cmd:
                kt = os.path.join(OUT, 'kt-%s.xml' % tag)
                d = run(kt_cmd + ['convert', src_path, kt] + opts + TZ)
                e = run([sys.executable, CLI, 'verify', src_path, kt] + opts + TZ) if d.returncode == 0 else d
                ok = (a.returncode == 0 and d.returncode == 0 and e.returncode == 0 and same_xml(py, kt) and
                      open(py[:-4] + '.manifest.csv', 'rb').read() == open(kt[:-4] + '.manifest.csv', 'rb').read())
                check(ok, '%s, %s (Android engine)' % (sname, oname))
                if not ok:
                    print('\n'.join(x.stdout[-1500:] + x.stderr[-1500:] for x in (d, e)))


def expectations():
    print('Specific results (default options, folder source):')
    path = os.path.join(OUT, 'py-folder-default.xml')
    root = ET.parse(path).getroot()
    sms = {e.get('body'): e for e in root.iter('sms')}
    mms = {}
    for e in root.iter('mms'):
        texts = [p.get('text') for p in e.iter('part') if p.get('ct') == 'text/plain']
        mms[texts[0] if texts else e.get('date')] = e
    report = open(path[:-4] + '.report.txt', encoding='utf-8').read()

    check(root.get('count') == str(len(root)), 'count attribute matches the number of messages (%s)' % root.get('count'))
    check('not convertible:   8 record(s)' in report, '4 unconvertible records and 4 unreadable lines are reported')
    check('abcdef' in sms, 'NUL characters removed from an SMS body, nothing else changed')
    check(' broken emoji' in sms, 'a lone UTF-16 surrogate is removed')
    check('Dinner? \U0001F355\U0001F389' in sms, 'emoji survive')
    check('Line one\nLine two' in sms and 'a\r\nb\tc' in sms, 'line breaks, CR and tabs survive')
    check('  spaced out  ' in sms, 'leading and trailing spaces survive')
    check('Tom & Jerry <3 "quotes" \'apostrophes\'' in sms, 'XML special characters survive')
    check(sms['null'].get('body') == 'null', 'a body that is literally "null" is kept')
    e = sms['Extra columns']
    check((e.get('protocol'), e.get('locked'), e.get('service_center')) == ('0', '1', '+15550100999'),
          'protocol, locked and service_center are carried when present')
    check(sms['Numbers instead of strings'].get('read') == '1', 'numeric JSON values become strings')
    check(sms['Group text sent as SMS'].get('address') == '+15550100201 +15550100202 +15550100203',
          'a multi-number SMS address is kept exactly')
    check(all(x.get('sub_id') == '-1' for x in root), 'every message gets sub_id -1 by default')
    check(mms['Look at this'].get('date') == str((T0 + 40 * 60) * 1000), 'MMS dates are converted from seconds to milliseconds')
    check(mms['Date already in milliseconds'].get('date') == str((T0 + 84 * 60) * 1000), 'an MMS date already in milliseconds is not multiplied again')
    group = {mms[t].get('address') for t in ('Group hello', 'Reply to all', 'Headers miss Cam', 'Unsorted address rows')}
    check(len(group) == 1 and set(group.pop().split('~')) == {'+15550100201', '+15550100202', '+15550100203'},
          'every MMS of the group has the same participants, without the owner')
    check(mms['Picture note to self'].get('address') == '+15550100100', 'notes to self are addressed to the owner')
    check(mms['Sent from the old app'].get('address') == '+15550100201', 'a sent MMS with an insert-address-token sender is addressed correctly')
    check(mms['No thread id'].get('address') == '+15550100203', 'an MMS without thread_id uses its own headers')
    check([a.get('address') for a in mms['Unsorted address rows'].iter('addr')] ==
          ['+15550100203', '+15550100100', '+15550100201', '+15550100202'], 'address rows are written in their original order')
    check(mms.get('Verticaltab in an MMS text') is not None, 'an illegal character in an MMS text part is removed')
    parts = {p.get('cl'): p for p in root.iter('part')}
    check(parts['empty.jpg'].get('data') == '', 'an empty attachment file is written as empty data')
    check(parts['voice.amr'].get('data') is None, 'a missing attachment file is written without data')
    check(len(parts['IMG_0001.jpg'].get('data')) == 6668, 'attachments are embedded as base64')
    check(mms['With a subject'].get('sub') == 'Weekend plans', 'MMS subjects are kept')
    check(all(x.get('readable_date') and x.get('contact_name') for x in root), 'every message has readable_date and contact_name')


def parts_of(path):
    """The files a conversion wrote: OUTPUT, or OUTPUT-part1, -part2, ... when split."""
    stem, ext = os.path.splitext(path)
    parts = [p for p in os.listdir(os.path.dirname(path)) if re.fullmatch(re.escape(os.path.basename(stem)) + r'-part\d+' +
                                                                         re.escape(ext), p)]
    parts.sort(key=lambda p: int(re.search(r'-part(\d+)', p).group(1)))
    return [os.path.join(os.path.dirname(path), p) for p in parts] or [path]


def content(path):
    """What must be identical between the engines: an XML file without its time stamps,
    or a ZIP file's entry names and contents."""
    if path.endswith('.xml'):
        lines = open(path, encoding='utf-8').read().split('\n')
        return [lines[0], lines[2], re.sub(r'backup_set="[^"]*" backup_date="[0-9]+"', '', lines[3])] + lines[4:]
    with zipfile.ZipFile(path) as z:
        return [(n, z.read(n)) for n in z.namelist()]


def formats(kt_cmd):
    print('Other formats: every source x output format x options (Python vs browser engine vs Android engine, '
          'files identical and verified):')
    sources = ['sbr-2026-01-15.xml', 'sbr-zipped.zip', 'wonder-2026-01-15.zip', 'pom-2026-01-15.zip',
               'buggy-2026-01-15.zip', 'messages-2026-01-15.zip']
    option_sets = {'default': [], 'test sample': ['--sample'],
                   'MMS only, no groups, no PDF': ['--keep', 'mms', '--no-groups', '--no-pdf'],
                   'split into parts': ['--split-mb', '0.004'], 'texts only, SIM kept': ['--keep', 'sms', '--sub-id', 'keep']}
    engines = {'py': [sys.executable, CLI, 'convert'], 'js': ['node', RUN_JS]}
    if kt_cmd:
        engines['kt'] = kt_cmd + ['convert']
    for src in sources:
        for to in ('sbr', 'fig', 'wonder'):
            if src.startswith('messages') and to == 'sbr':
                continue  # covered above
            ext = '.xml' if to == 'sbr' else '.zip'
            for oname, opts in option_sets.items():
                tag = re.sub(r'\W+', '-', '%s-%s-%s' % (src, to, oname))
                results, errors = {}, []
                for e, cmd in engines.items():
                    out = os.path.join(OUT, 'fmt-%s-%s%s' % (e, tag, ext))
                    r = run(cmd + [os.path.join(OUT, src), out, '--to', to, '--force'] + opts + TZ)
                    if r.returncode:
                        errors.append('%s: %s' % (e, (r.stdout + r.stderr)[-600:]))
                        continue
                    files = parts_of(out)
                    results[e] = ([content(f) for f in files], [open(f[:-4] + '.manifest.csv', 'rb').read() for f in files])
                same = not errors and all(results[e] == results['py'] for e in results)
                check(same, '%s -> %s, %s' % (src, to, oname))
                if not same:
                    print('\n'.join(errors) or '  outputs differ between %s' % ', '.join(results))
                if to == 'sbr' and not errors and 'split' not in oname:
                    for e in engines:
                        if e != 'py':
                            out = os.path.join(OUT, 'fmt-%s-%s%s' % (e, tag, ext))
                            v = run([sys.executable, CLI, 'verify', os.path.join(OUT, src), out] + opts + TZ)
                            if v.returncode:
                                check(False, 'the Python verifier accepts the %s output (%s)' % (e, tag))
                                print(v.stdout[-800:])


def format_expectations():
    print('Other formats: specific results:')
    py = lambda src, to, oname, ext='.xml': os.path.join(OUT, 'fmt-py-%s%s' % (re.sub(r'\W+', '-', '%s-%s-%s' % (src, to, oname)), ext))

    def messages(path):
        root = ET.parse(path).getroot()
        return root, {e.get('body'): e for e in root.iter('sms')}, list(root.iter('mms'))

    root, sms, mms = messages(py('sbr-2026-01-15.xml', 'sbr', 'default'))
    check(sms['Hi from SBR & friends <3'].get('contact_name') == 'Alex Example', 'SMS Backup & Restore: entities and contact names')
    check('Line one\nLine two\r\nthree' in sms, 'SMS Backup & Restore: character references for line breaks are kept')
    check('literal line break and tab' in sms, 'SMS Backup & Restore: a literal line break in an attribute becomes a space, as XML says')
    check("emoji \U0001F600 and \U0001F600 'x'" in sms, 'SMS Backup & Restore: emoji written as character references')
    check('single "quoted" attribute' in sms, 'SMS Backup & Restore: single-quoted attributes')
    check(sms['null'].get('body') == 'null', 'SMS Backup & Restore: a text that says "null" is kept')
    parts = {p.get('cl'): p for p in root.iter('part')}
    check(parts['wrapped.png'].get('data') == parts['image0.png'].get('data') and len(parts['image0.png'].get('data')) > 40,
          'SMS Backup & Restore: base64 split over lines is decoded to the same picture')
    check(parts['empty.jpg'].get('data') == '' and parts['broken.jpg'].get('data') is None,
          'SMS Backup & Restore: an empty attachment stays empty, invalid base64 is reported as missing')
    group = next(m for m in mms if m.get('msg_box') == '2')
    check([a.get('address') for a in group.iter('addr')] == ['+15550100202', '+15550100100', '+15550100201', '+15550100203']
          and set(group.get('address').split('~')) == {'+15550100201', '+15550100202', '+15550100203'},
          'SMS Backup & Restore: address rows keep their order; the group keeps its members')
    root, sms, mms = messages(py('sbr-2026-01-15.xml', 'sbr', 'MMS only, no groups, no PDF'))
    check(not sms and len(mms) == 2 and not any(p.get('ct') == 'application/pdf' for p in root.iter('part')),
          '"what to keep": MMS only, without the group MMS and the PDF')

    root, sms, mms = messages(py('wonder-2026-01-15.zip', 'sbr', 'default'))
    parts = {p.get('cl'): p for p in root.iter('part')}
    check(len(parts['photo.jpg'].get('data') or '') == 4000 and parts['lost.jpg'].get('data') is None and
          parts['menu.pdf'].get('data'), 'Wonder: attachments from mms_attachments/ are embedded; a missing one is reported')
    check({p.get('seq') for p in root.iter('part') if p.get('ct') == 'application/smil'} == {'-1'} and
          {p.get('seq') for p in root.iter('part') if p.get('ct') != 'application/smil'} == {'0'}, 'Wonder: part order numbers are filled in')
    check(mms[0].get('date') == str((T0 + 103 * 60) * 1000), 'Wonder: MMS dates in seconds become milliseconds')

    root, sms, mms = messages(py('pom-2026-01-15.zip', 'sbr', 'default'))
    check(all('/TYPE=PLMN' not in (a.get('address') or '') for a in root.iter('addr')), 'Pom: "/TYPE=PLMN" is removed from addresses')
    check([a.get('address') for a in mms[1].iter('addr')] == ['+15550100201'] and mms[1].get('address') == '+15550100201',
          'Pom: an MMS that lists only recipients (<r>) gets their address')
    check(any(p.get('cl') == 'pic.png' and p.get('data') for p in root.iter('part')), 'Pom: _data_b64 attachments are embedded')

    root, sms, mms = messages(py('buggy-2026-01-15.zip', 'sbr', 'default'))
    check([e.get('body') for e in root.iter('sms')] == ['Buggy hello', 'Buggy reply \U0001F44D', 'Buggy tenth (sorted after conv_2)'],
          'Buggy Backup: entries in number order (conv_10 after conv_2)')
    check([e.get('read') for e in root.iter('sms')] == ['1', '1', '0'] and sms['Buggy hello'].get('protocol') == '0',
          'Buggy Backup: true/false and numbers become column values')
    report = open(py('buggy-2026-01-15.zip', 'sbr', 'default')[:-4] + '.report.txt', encoding='utf-8').read()
    check('records:           5 records (0 blank, 2 unreadable)' in report, 'Buggy Backup: damaged entries are reported')

    with zipfile.ZipFile(py('sbr-2026-01-15.xml', 'fig', 'default', '.zip')) as z:
        lines = [json.loads(x) for x in z.read('messages.ndjson').decode('utf-8').splitlines()]
        names = z.namelist()
    mms_rows = [o for o in lines if '__parts' in o]
    files = [p['_data'].rsplit('/', 1)[-1] for o in mms_rows for p in o['__parts'] if '_data' in p]
    check(all(int(o['date']) < 10 ** 11 for o in mms_rows) and files == [n[5:] for n in names[1:]] and
          not any(p.get('cl') == 'broken.jpg' and '_data' in p for o in mms_rows for p in o['__parts']),
          'Fig / TAK output: MMS dates in seconds, every attachment file in data/, none for the broken one')
    check([o['_id'] for o in lines] == [str(i) for i in range(1, len(lines) + 1)] and
          len({o['thread_id'] for o in lines}) == 6, 'Fig / TAK output: row ids and one thread per conversation')

    direct = os.path.join(OUT, 'roundtrip-direct.xml')
    via = os.path.join(OUT, 'roundtrip-fig.zip')
    back = os.path.join(OUT, 'roundtrip-back.xml')
    a = run([sys.executable, CLI, 'convert', os.path.join(OUT, 'messages-2026-01-15.zip'), direct, '--force'] + TZ)
    b = run([sys.executable, CLI, 'convert', os.path.join(OUT, 'messages-2026-01-15.zip'), via, '--to', 'fig', '--force'] + TZ)
    c = run([sys.executable, CLI, 'convert', via, back, '--force'] + TZ)
    check(not (a.returncode or b.returncode or c.returncode) and same_xml(direct, back),
          'Fig / TAK round trip: Fig -> Fig ZIP -> SMS Backup & Restore equals Fig -> SMS Backup & Restore')

    for src in ('sbr-2026-01-15.xml', 'wonder-2026-01-15.zip'):
        one = parts_of(py(src, 'sbr', 'default'))
        split = parts_of(py(src, 'sbr', 'split into parts'))
        def count(files):
            out = []
            for f in files:
                for e in ET.parse(f).getroot():
                    e.tail = None
                    out.append(ET.tostring(e))
            return sorted(out)
        check(len(one) == 1 and len(split) > 1 and count(one) == count(split),
              'splitting %s into %d parts keeps every message exactly once' % (src, len(split)))
    for src in ('sbr-2026-01-15.xml', 'wonder-2026-01-15.zip', 'pom-2026-01-15.zip', 'buggy-2026-01-15.zip'):
        check(len(messages(py(src, 'sbr', 'test sample'))[0]) > 0, 'a test file from %s holds messages' % src)


def zip_tests():
    print('ZIP reader:')
    work = os.path.join(OUT, 'zip-tests')
    os.makedirs(work, exist_ok=True)
    with open(os.path.join(work, 'cp437.txt'), 'w', encoding='utf-8') as f:
        f.write(bytes(range(256)).decode('cp437'))
    big = os.path.join(work, 'zip64.zip')
    if not os.path.exists(big):
        with zipfile.ZipFile(big, 'w', zipfile.ZIP_STORED) as z:
            for i in range(70000):
                z.writestr('f/%d.txt' % i, 'entry %d' % i)
    with zipfile.ZipFile(os.path.join(work, 'stored.zip'), 'w', zipfile.ZIP_STORED) as z:
        z.writestr('hello.txt', 'hello, stored world')
    damaged = os.path.join(work, 'damaged.zip')
    with zipfile.ZipFile(damaged, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('data.bin', bytes(range(256)) * 64)
    data = bytearray(open(damaged, 'rb').read())
    data[60] ^= 0xFF  # inside the compressed data
    open(damaged, 'wb').write(bytes(data))
    r = run(['node', os.path.join(HERE, 'test_zip.mjs'), work])
    print(r.stdout.rstrip())
    check(r.returncode == 0, 'ZIP reader unit tests pass' + ('' if r.returncode == 0 else ': ' + r.stderr[-500:]))


def well_formed():
    if not shutil.which('xmllint'):
        return
    print('libxml2 (xmllint):')
    files = sorted(f for f in os.listdir(OUT) if f.endswith('.xml'))
    bad = [f for f in files if run(['xmllint', '--noout', os.path.join(OUT, f)]).returncode]
    check(not bad, '%d output files are well-formed XML%s' % (len(files), ': bad ' + ', '.join(bad) if bad else ''))


def main():
    os.makedirs(OUT, exist_ok=True)
    r = run([sys.executable, os.path.join(HERE, 'make_fixture.py'), OUT])
    if r.returncode:
        sys.exit(r.stderr)
    kt_cmd = kotlin_engine()
    equivalence(kt_cmd)
    expectations()
    formats(kt_cmd)
    format_expectations()
    zip_tests()
    well_formed()
    print('\n%s' % ('ALL TESTS PASSED' if not failures else '%d FAILED' % len(failures)))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
