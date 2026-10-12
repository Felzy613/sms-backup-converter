# SMS Backup Converter

Converts a backup made by **SMS Import / Export** (`messages-YYYY-MM-DD.zip`, or its unzipped
folder) into an XML backup that **SMS Backup & Restore** can restore, then reads the result back
and checks every message and attachment against the original.

There are three versions, and they produce byte-identical XML:

| | Where | How to run |
|---|---|---|
| Android app | [`android`](android) | install the APK from [Releases](../../releases) |
| Python command line | [`cli/sie_to_sbr.py`](cli/sie_to_sbr.py) | `python3 sie_to_sbr.py convert SOURCE sms-20261005120000.xml` |
| JavaScript engine | [`assets`](assets) | `node tests/run_js.mjs SOURCE OUTPUT.xml` |

## The Android app is offline ("kosher")

It requests **no permissions at all**, so it cannot use the internet. It has no WebView and no
links, cannot open web pages or install apps, and uses no third-party libraries. Files are read
and written only through the system file picker. A build check (`./gradlew :app:kosherCheck`)
fails if any of that ever changes. See [the app's README](android/README.md).

## Using it

1. Make a small **test file** first, restore it with SMS Backup & Restore, and check that a few
   conversations look right.
2. Then convert all messages and restore that file.

Each conversion also writes a `.report.txt` (what was converted and the verification result)
and a `.manifest.csv` (one row per message).
