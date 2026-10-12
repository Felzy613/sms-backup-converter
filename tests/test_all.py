#!/usr/bin/env python3
"""Test suite: python3 tests/test_all.py   (needs Python 3.9+ and Node 20+)

1. Builds a synthetic export (tests/make_fixture.py; all data is made up).
2. Converts it with the Python CLI, the browser engine (under Node) and the Android app's
   engine (android/core, built with JDK 17 to 24; skipped with a notice when there is none),
   for four source layouts and several option sets, and requires byte-identical XML and
   manifests, a passing self-check, and the Python verifier passing the other engines'
   output.
3. Checks specific results in the XML against hand-written expectations.
4. Runs the ZIP reader's unit tests (ZIP64, stored entries, damage detection, CP437).
Output goes to tests/output/ (ignored by git).
"""

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


def equivalence():
    print('Python CLI vs browser engine vs Android engine (byte-identical XML and manifest, all verified):')
    kt_cmd = kotlin_engine()
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
    equivalence()
    expectations()
    zip_tests()
    well_formed()
    print('\n%s' % ('ALL TESTS PASSED' if not failures else '%d FAILED' % len(failures)))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
