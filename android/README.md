# SMS Backup Converter (Android)

An Android app that converts a text-message backup from one phone's format into another's, on
the phone itself. It reads **Fig / TAK** (SMS Import / Export), **SMS Backup & Restore**,
**Wonder**, **Pom** and **Buggy Backup** backups, and writes **SMS Backup & Restore**,
**Fig / TAK** or **Wonder** backups. It is the same converter as `../cli/sie_to_sbr.py` and
`../assets/converter.js`, and writes byte-identical files.

## Offline / kosher

- **No permissions at all.** Without `INTERNET` Android does not let the app open a network
  connection. There is no storage permission either: files are opened only through the system
  file picker.
- **No web browsing.** There is no WebView, there are no links, and text cannot be selected (so
  there is no "Web search" or "Share" action). The text boxes' menu only offers cut, copy and
  paste. The only other screens the app ever opens are the system file pickers.
- **No app installation or downloads.** There is no installer code and no download code.
- **No libraries.** The app uses only the Android framework and the Kotlin standard library:
  no AndroidX, no Google Play services, no analytics.
- `./gradlew :app:kosherCheck` builds the release APK and fails if the APK requests any
  permission or its code references WebView, networking, the package installer, or
  URL / share / web-search intents.

## How it works

1. Choose the backup file: a ZIP or an SMS Backup & Restore XML file (or an unzipped Fig / TAK
   folder). The app detects the format from the contents and shows what it found.
2. Choose the new phone's format (SMS Backup & Restore, Fig / TAK or Wonder) and what to keep:
   everything, only SMS or only MMS, and optionally without group chats or PDF files.
3. Choose a folder to save to. On Android 11 and later the picker does not allow Download
   itself, so create a folder inside it (e.g. Download/SMS). The app remembers the folder.
4. Tap **Make a test file** (a few representative messages) or **Convert all messages**.
5. The app writes the backup (`sms-YYYYMMDDHHMMSS.xml`, `messages-YYYY-MM-DD.zip` or
   `Messages_Backup_YYYY-MM-DD.zip`), then checks the saved file: an XML file is read back
   with a strict XML parser and every message compared, field by field and every attachment by
   SHA-256, with the backup; a ZIP is read back entry by entry. Every file is synced to storage
   before it gets its final name, and only a file that passes the check gets it (a failed or
   interrupted one keeps a `.partial` name). A `.report.txt` and a `.manifest.csv` (one row per
   message) are saved next to it.
6. Restore it on the new phone; the app shows the steps for the chosen format.

**More options** covers saving a big backup as several files of at most a chosen size
(`-part1`, `-part2`, …; conversations are kept together and no message is split), the time
zone for the date text, your own number (if it was not detected), the SIM id written to each
message, and how to handle characters XML cannot hold. These are the same options as the
command-line version.

## Tested

- Android 15 (API 35) and Android 8.0 (API 26, the minimum) emulators, with a real export of
  28,373 messages and 2,021 attachments (579 MB ZIP, 804 MB XML): ZIP and unzipped-folder
  sources, test file and full conversion, cancel, rotation, dark mode, wrong files, and a hard
  power-off right after saving. A full conversion took 10 s (Android 15) to 71 s (Android 8.0
  with 2 GB RAM) and used under 60 MB of memory.
- Version 1.1: on Android 15, the same export to Wonder with only MMS, no PDF files, in parts
  of at most 200 MB (4 parts in 36 s), and an SMS Backup & Restore XML file to Fig / TAK; on
  Android 8.0, a Pom backup to an SMS Backup & Restore test file. Every file and manifest was
  byte-identical to the desktop engines' output.
- The files written on the device are byte-identical to the desktop engine's, which are
  byte-identical to the Python and browser versions (apart from the XML header's time stamp
  and backup id).
- Not yet tested: restoring the results on a real phone, and backups made by real Wonder, Pom
  and Buggy Backup phones (those formats are tested with made-up backups).

## Build

Requires JDK 17 to 24 and the Android SDK (platform 35).

    ./gradlew :app:kosherCheck      # release APK + offline audit
    # -> app/build/outputs/apk/release/app-release.apk  (signed with the local debug key)
    ./gradlew :core:test            # engine unit tests

The engine (`core/`) is plain Kotlin with no Android dependency, so it can also run on a
desktop and be compared with the other two versions:

    ./gradlew :core:cli --args="convert /path/to/backup /tmp/sms.xml --tz America/New_York"
    node ../tests/run_js.mjs /path/to/backup /tmp/sms-js.xml --tz America/New_York
    cmp <(sed '2d;4d' /tmp/sms.xml) <(sed '2d;4d' /tmp/sms-js.xml)   # only the header lines differ

The CLI takes the same options as the Python version (`--to`, `--keep`, `--no-groups`,
`--no-pdf`, `--split-mb`, `--sample`, `--sub-id`, `--tz`, `--nul`, `--owner`).
