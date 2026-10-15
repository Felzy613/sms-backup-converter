# SMS Backup Converter

Move your text messages to another phone, even when the two phones save their backups in different formats. Texts, picture messages, group chats and attachments are all carried over.

- **Private.** It runs entirely on your own device. Nothing is uploaded: the web page is blocked from contacting any server, and the Android app has no internet access at all.
- **Careful.** Every message is written exactly as stored: numbers, text, timestamps, sent/received, read and delivery status, every MMS part and attachment. Each file is then read back and checked against the original.
- **Three versions, one result.** A web page, an Android app and a Python command line. All three write byte-identical files.

| Version | Use it when | Get it |
|---|---|---|
| **Web page** | you have a computer | open `index.html` in a browser |
| **Android app** | you only have the phone, including a filtered ("kosher") phone | install the APK from [Releases](../../releases) |
| **Command line** | you want to script it | `python3 cli/sie_to_sbr.py` |

## Phones and formats

| Phone / app | Backup it makes | Can be read | Can be made |
|---|---|:---:|:---:|
| **SMS Backup & Restore** (any Android phone, including the **MindPhone**) | `sms-….xml` | ✅ SMS + MMS | ✅ SMS + MMS |
| **Fig**, **TAK** (SMS Import / Export) | `messages-YYYY-MM-DD.zip`, or its unzipped folder | ✅ SMS + MMS | ✅ SMS + MMS |
| **Wonder** | a ZIP with `Messages_Backup_….xml` and `mms_attachments/` | ✅ SMS + MMS | ✅ SMS + MMS |
| **Pom** | a ZIP with `sms.xml` and `mms.xml` (an older Pom makes the Fig format) | ✅ SMS + MMS | ❌ |
| **Buggy Backup** | a ZIP with `conversations/conv_N` | ✅ SMS (it holds no MMS) | ❌ |

The format is detected from the file's contents. Fig and TAK use the same format: a backup from one restores on the other as it is.

The Wonder, Pom and Buggy Backup formats were worked out by studying the [Kosher Phone SMS Converter](https://github.com/pythonivelt/kosher-sms-converter); no code was taken from it. They are tested with made-up backups; if a real one does not convert, please open an issue.

## What to keep, and big backups

- **What to keep:** everything, only text messages (SMS), or only picture and group messages (MMS); and you can leave out group chats or PDF files. Leaving things out makes the new backup smaller, and some phones' messaging apps cannot show PDF files.
- **Big backups** can be saved as several files of at most a chosen size (`-part1`, `-part2`, …). A conversation stays in one file whenever it fits, and no message is split. Restore the parts in order, part 1 first. Browsers that cannot save straight to disk (Safari, Firefox, phones) split backups over 500 MB by themselves.

## Using the web page

1. Download this repository: **Code → Download ZIP** on GitHub, then unzip it.
2. Open `index.html` in Chrome, Edge, Firefox or Safari.
3. Choose the backup file from your old phone (or the folder an unzipped Fig / TAK backup is in).
4. Choose the new phone's format and what to keep.
5. Click **Create test file**, restore it on the phone and check it. Then click **Create full backup** and restore that.

Chrome and Edge save straight to disk (and save all the parts of a big backup into one folder you choose), which is best for large backups. Other browsers build each file in memory, then download it.

## Using the Android app

Install `SmsBackupConverter-….apk` from [Releases](../../releases) (Android 8.0 or later). Then:

1. Choose the backup file (or the unzipped Fig / TAK folder).
2. Choose the new phone's format and what to keep.
3. Choose a folder to save to. Android 11 and later don't allow the Download folder itself, so create one inside it, for example `Download/SMS`.
4. Tap **Make a test file**, restore it and check it. Then tap **Convert all messages**.

The app is offline by design: it requests **no permissions**, has no WebView and no links, cannot open web pages, and cannot download or install apps. Files are read and written only through Android's own file picker. Details are in [android/README.md](android/README.md).

## Restoring on the new phone

**SMS Backup & Restore** (any Android phone, including the MindPhone):

1. Install **SMS Backup & Restore** (by SyncTech) and open it.
2. In its *Settings → Backup settings → Local backup folder*, choose or create a folder (for example `SMSBackupRestore`).
3. Copy the `sms-….xml` file into that folder. Keep the name starting with `sms-`. (The Android app can save straight into that folder.)
4. Optional: *Menu → View backups* lets you look inside the file without changing anything.
5. Tap *Restore*, pick the file, tick *Messages* and start. Let the app be your SMS app while it restores, then switch back.

**Fig or TAK:** copy the `messages-….zip` file to the phone (don't unzip it), open its message backup / restore screen (SMS Import / Export), choose *Import* and pick the file.

**Wonder:** copy the `Messages_Backup_….zip` file to the phone (don't unzip it), open its message backup screen, choose *Restore* and pick the file.

Good to know:

- Restore the test file first, and check names, times, sent/received sides, photos and group chats.
- A phone that already has messages keeps them. Restoring adds the old messages to the same chats and skips any message that is already there, so nothing shows up twice. That is also why restoring the full backup after the test file is fine.
- Several parts: restore part 1 first, then the others in order.
- Keep your original backup until you have checked the restored messages.

## What the converter does

Every backup is read into the same records: the columns of Android's own message tables, which is what SMS Import / Export writes (`messages.ndjson`, one JSON object per message, and a `data/` folder of MMS attachments) and what the other formats hold in their own layout. The records are then written in the new phone's format. For the [XML format SMS Backup & Restore reads](https://www.synctech.com.au/sms-backup-restore/fields-in-xml-backup-files/):

| | |
|---|---|
| SMS | address, body, date, date sent, type (received/sent/…), read, status, and protocol / locked / service center when present |
| MMS | every header (message id, transaction id, type, box, subject, read, priority, reports, …) |
| MMS parts | all parts in their original order, with attachments embedded as base64 |
| MMS addresses | all From / To / Cc / Bcc rows in their original order |
| Group chats | each MMS's `address` lists the conversation's other members (joined with `~`, your own number left out), so Android rebuilds the same group conversation |
| Dates | SMS dates are unchanged. MMS dates are stored in seconds by Android and in milliseconds by SMS Backup & Restore, so they are multiplied by 1000 (which the app reverses on restore). |

A Fig / TAK backup is written the way SMS Import / Export writes its own (records from a Fig / TAK backup are written back unchanged, apart from the options). A Wonder backup holds the main parts of each message: texts, dates, sent/received, read, pictures and other attachments, and group members.

Deliberate changes, all listed in the report:

- **SIM id (`sub_id`) is written as -1, meaning "unknown SIM".** Since Android 14, the system hides messages whose SIM id belongs to a different phone; restored messages are expected to use -1 (see AOSP `ProviderUtil.getSelectionBySubIds`). The original ids are kept in the message list (CSV). You can keep them, or set a specific id, under *More options*.
- **Characters XML can't store are removed.** XML cannot store certain invisible control characters such as NUL, so they are removed, or replaced with `�` if you choose.
- **Group MMS stay in their group.** If a group MMS lists fewer people in its headers than its group, it is still filed in that group, as it was on the old phone. Its real headers are kept unchanged.

Not available in these backups, so not in the result: drafts the messaging app kept to itself, call logs, blocked numbers, and RCS chats Google Messages didn't copy into Android's MMS store.

## Command line

```bash
python3 cli/sie_to_sbr.py analyze messages-2026-01-15.zip
python3 cli/sie_to_sbr.py convert messages-2026-01-15.zip sms-test-20260115120000.xml --sample
python3 cli/sie_to_sbr.py convert messages-2026-01-15.zip sms-20260115120000.xml
python3 cli/sie_to_sbr.py convert sms-20260115120000.xml messages-2026-01-15.zip --to fig --keep sms
python3 cli/sie_to_sbr.py convert Messages_Backup_2026-01-15.zip sms-20260115120000.xml --split-mb 500
```

`convert` writes the backup, a `.report.txt` and a `.manifest.csv` (one row per message, with its original ids), then checks what it wrote: an SMS Backup & Restore file is re-read with a strict XML parser and every message compared with its source; a ZIP is re-read entry by entry.

Options:

| Option | What it does |
|---|---|
| `--to sbr\|fig\|wonder` | The format to write: SMS Backup & Restore XML (default), Fig / TAK ZIP, or Wonder ZIP. |
| `--keep all\|sms\|mms` | Which messages to write. Default: all. |
| `--no-groups` | Leave out group chats. |
| `--no-pdf` | Leave out PDF attachments. |
| `--split-mb 500` | Write outputs bigger than this as several files (`-part1`, `-part2`, …). |
| `--sample` | Write only a small test set. |
| `--sub-id unknown\|keep\|N` | SIM id written for every message. Default: `unknown` (-1). |
| `--tz America/New_York` | Time zone for the human-readable dates. |
| `--nul strip\|replace` | Remove characters XML can't store, or replace them with `�`. |
| `--owner +15550100100` | Your own number, if it isn't detected automatically. |
| `--force` | Overwrite existing output files. |

It needs only Python 3.8+, with no extra packages.

## Tests

```bash
python3 tests/test_all.py
```

The tests need Python 3.9+ and Node 20+, plus a JDK 17 to 24 for the Android engine (it is skipped, with a notice, when none is found). They build backups full of made-up messages in every format (`tests/make_fixture.py`), then check that:

- The browser engine (`assets/converter.js`), the Android app's engine (`android/core`) and the Python version produce **byte-identical** files for every source format, every output format and several option combinations (what to keep, test sample, SIM ids, splitting into parts).
- The Python verifier accepts the other two engines' output.
- A list of specific results comes out right: group chats, notes to self, empty, missing and broken attachments, emoji, control characters and XML escapes, unconvertible records, each format's quirks, a round trip through the Fig / TAK format, and splitting without losing a message.
- The ZIP reader handles ZIP64, data descriptors and damaged files.

The Android app has its own unit tests and an offline audit: see [android/README.md](android/README.md).

## Files

- `index.html`, `assets/`: the web app. `converter.js` is the engine, `zip.js` a small ZIP reader and writer, `app.js` the page.
- `android/`: the Android app. `core/` is the engine (a Kotlin port of `converter.js` and `zip.js`), `app/` the screens.
- `cli/sie_to_sbr.py`: the command-line version.
- `tests/`: the test suite and the made-up test data generator.

## Disclaimer

This project is not affiliated with SyncTech Pty Ltd (SMS Backup & Restore), the SMS Import / Export project, or the makers of the phones named here. Keep your original backup until you have checked the restored messages.

[MIT License](LICENSE)
