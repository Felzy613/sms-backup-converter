# SMS Backup Converter (Android)

An Android app that converts an **SMS Import / Export** backup (`messages-YYYY-MM-DD.zip`, or
its unzipped folder) into an XML backup that **SMS Backup & Restore** can restore, on the phone
itself. It is the same converter as `../cli/sie_to_sbr.py` and `../assets/converter.js`, and
writes byte-identical XML.

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

1. Choose the backup ZIP (or the unzipped folder). The app reads it and shows what it found.
2. Choose a folder to save to. On Android 11 and later the picker does not allow Download
   itself, so create a folder inside it (e.g. Download/SMS). The app remembers the folder.
3. Tap **Make a test file** (about 20 representative messages) or **Convert all messages**.
4. The app writes `sms-YYYYMMDDHHMMSS.xml`, then reads the saved file back with a strict XML
   parser and compares every message, field by field and every attachment by SHA-256, with
   the backup. Every file is synced to storage before it gets its final name, and only a file
   that passes verification gets its `.xml` name (a failed or interrupted one stays
   `.xml.partial`). A `.report.txt` and a `.manifest.csv` (one row per message) are saved next
   to it.
5. Restore the XML file with SMS Backup & Restore.

**More options** covers the time zone for the date text, your own number (if it was not
detected), the SIM id written to each message, and how to handle characters XML cannot hold.
These are the same options as the command-line version.

## Tested

- Android 15 (API 35) and Android 8.0 (API 26, the minimum) emulators, with a real export of
  28,373 messages and 2,021 attachments (579 MB ZIP, 804 MB XML): ZIP and unzipped-folder
  sources, test file and full conversion, cancel, rotation, dark mode, wrong files, and a hard
  power-off right after saving. A full conversion took 10 s (Android 15) to 71 s (Android 8.0
  with 2 GB RAM) and used under 60 MB of memory.
- The XML written on the device is byte-identical to the desktop engine's, which is
  byte-identical to the Python and browser versions (apart from the header's time stamp and
  backup id).
- Not yet tested: restoring the result in SMS Backup & Restore on a real phone.

## Build

Requires JDK 17+ and the Android SDK (platform 35).

    ./gradlew :app:kosherCheck      # release APK + offline audit
    # -> app/build/outputs/apk/release/app-release.apk  (signed with the local debug key)
    ./gradlew :core:test            # engine unit tests

The engine (`core/`) is plain Kotlin with no Android dependency, so it can also run on a
desktop and be compared with the other two versions:

    ./gradlew :core:cli --args="convert /path/to/export /tmp/sms.xml --tz America/New_York"
    node ../tests/run_js.mjs /path/to/export /tmp/sms-js.xml --tz America/New_York
    cmp <(sed '2d;4d' /tmp/sms.xml) <(sed '2d;4d' /tmp/sms-js.xml)   # only the header lines differ
