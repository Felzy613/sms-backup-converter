# SMS Backup Converter

Move your text messages from an **SMS Import / Export** backup into **SMS Backup & Restore**, so you can restore them on a new Android phone. Texts, picture messages, group chats and attachments are all carried over.

- **Private.** It runs entirely in your browser or on your computer. Nothing is uploaded. The web page is even blocked from contacting any server.
- **Careful.** Every message is written exactly as stored: numbers, text, timestamps, sent/received, read and delivery status, every MMS part and attachment. Each one is then read back and checked against the original.
- **No install needed.** Open `index.html` in a browser. A Python command-line version is included too.

## Using it

1. Download this repository: **Code → Download ZIP** on GitHub, then unzip it.
2. Open `index.html` in Chrome, Edge, Firefox or Safari.
3. Choose your `messages-YYYY-MM-DD.zip` from SMS Import / Export, or the folder you unzipped it into.
4. Click **Create test file**, restore it on the phone (steps below) and check it.
5. Click **Create full backup** and restore that.

Chrome and Edge save straight to disk, which is best for large backups (hundreds of MB). Other browsers build the file in memory, then download it.

### Restoring on the phone

1. Install **SMS Backup & Restore** (by SyncTech) from Google Play.
2. In its *Settings → Backup settings → Local backup folder*, choose or create a folder (for example `SMSBackupRestore`).
3. Copy the `sms-….xml` file into that folder. Keep the name starting with `sms-`.
4. Optional: *Menu → View backups* lets you look inside the file without changing anything.
5. Tap *Restore*, pick the file, tick *Messages* and start. Let the app be your SMS app while it restores, then switch back.

Restore the test file first. Restoring the full backup afterwards skips messages that are already on the phone.

## What the converter does

SMS Import / Export writes `messages.ndjson` (one JSON object per message, with Android's own database columns) and a `data/` folder of MMS attachments. The converter maps these onto the [XML format SMS Backup & Restore reads](https://www.synctech.com.au/sms-backup-restore/fields-in-xml-backup-files/):

| | |
|---|---|
| SMS | address, body, date, date sent, type (received/sent/…), read, status, and protocol / locked / service center when present |
| MMS | every header (message id, transaction id, type, box, subject, read, priority, reports, …) |
| MMS parts | all parts in their original order, with attachments embedded as base64 |
| MMS addresses | all From / To / Cc / Bcc rows in their original order |
| Group chats | each MMS's `address` lists the conversation's other members (joined with `~`, your own number left out), so Android rebuilds the same group conversation |
| Dates | SMS dates are unchanged. MMS dates are stored in seconds by Android and in milliseconds by SMS Backup & Restore, so they are multiplied by 1000 (which the app reverses on restore). |

Deliberate changes, all listed in the report:

- **SIM id (`sub_id`) is written as -1, meaning "unknown SIM".** Since Android 14, the system hides messages whose SIM id belongs to a different phone; restored messages are expected to use -1 (see AOSP `ProviderUtil.getSelectionBySubIds`). The original ids are kept in the message list (CSV). You can keep them, or set a specific id, under *Options*.
- **Characters XML can't store are removed.** XML cannot store certain invisible control characters such as NUL, so they are removed, or replaced with `�` if you choose.
- **Group MMS stay in their group.** If a group MMS lists fewer people in its headers than its group, it is still filed in that group, as it was on the old phone. Its real headers are kept unchanged.

Not available in an SMS Import / Export backup, so not in the result: drafts the messaging app kept to itself, call logs, blocked numbers, and RCS chats Google Messages didn't copy into Android's MMS store.

## Command line

```bash
python3 cli/sie_to_sbr.py analyze messages-2026-01-15.zip
python3 cli/sie_to_sbr.py convert messages-2026-01-15.zip sms-test-20260115120000.xml --sample
python3 cli/sie_to_sbr.py convert messages-2026-01-15.zip sms-20260115120000.xml
```

`convert` writes the XML, a `.report.txt` and a `.manifest.csv` (one row per message, with its original ids), then re-reads the XML with a strict parser and checks every message against the source.

Options:

| Option | What it does |
|---|---|
| `--sub-id unknown\|keep\|N` | SIM id written for every message. Default: `unknown` (-1). |
| `--tz America/New_York` | Time zone for the human-readable dates. |
| `--nul strip\|replace` | Remove characters XML can't store, or replace them with `�`. |
| `--owner +15550100100` | Your own number, if it isn't detected automatically. |
| `--force` | Overwrite an existing output file. |

It needs only Python 3.8+, with no extra packages.

## Tests

```bash
python3 tests/test_all.py
```

The tests need Python 3.9+ and Node 20+. They build a backup full of made-up messages (`tests/make_fixture.py`), then check that:

- The browser engine (`assets/converter.js`) and the Python version produce **byte-identical** files across ZIP and folder sources and several option combinations.
- The Python verifier accepts the browser engine's output.
- A list of specific results comes out right: group chats, notes to self, empty and missing attachments, emoji and control characters, unconvertible records.
- The ZIP reader handles ZIP64, data descriptors and damaged files.

## Files

- `index.html`, `assets/`: the web app. `converter.js` is the engine, `zip.js` a small ZIP reader, `app.js` the page.
- `cli/sie_to_sbr.py`: the command-line version.
- `tests/`: the test suite and the made-up test data generator.

## Disclaimer

This project is not affiliated with SyncTech Pty Ltd (SMS Backup & Restore) or the SMS Import / Export project. Keep your original backup until you have checked the restored messages.

[MIT License](LICENSE)
