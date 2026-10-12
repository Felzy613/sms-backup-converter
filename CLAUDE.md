# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Converts an **SMS Import / Export** export (`messages-YYYY-MM-DD.zip` or its unzipped folder: `messages.ndjson` + `data/PART_*`) into the XML backup format that **SMS Backup & Restore** (SyncTech) restores, then verifies the result.

This folder is the git repo for the public GitHub repo `Felzy613/sms-backup-converter` (`origin`). It merged in the earlier web-only repo `Felzy613/FIg-SMS-to-SyncTech-SMS-Backup-and-Restore` (remote `html`) with its history. Releases on GitHub carry the APK (`gh release`); the APK itself is gitignored.

- `messages-2026-09-08 (recovered)/` — the user's **real, private** message export (28,373 messages, ~580 MB), gitignored. Use it only as read-only test input; never modify it, never commit it, and never upload or send its contents anywhere. The repo is public.
- Three implementations of the converter that must stay in lockstep:
  - `cli/sie_to_sbr.py` — the reference: Python 3.8+, standard library only (`analyze`, `convert`, `verify` subcommands).
  - `index.html` + `assets/` — the web app. `converter.js` (engine) and `zip.js` are a line-for-line port for browsers and Node; `app.js` is the page. The page's CSP sets `connect-src 'none'`, so it cannot make network requests; keep it that way.
  - `android/` — the Android app. `core/` is a Kotlin port of `converter.js`/`zip.js` with no Android dependency; `app/` is the UI.
- `tests/` — `test_all.py` (the cross-implementation suite), `make_fixture.py` (a made-up export full of edge cases), `run_js.mjs` (runs the JS engine under Node), `test_zip.mjs`.
- `SmsBackupConverter-1.0.0.apk` — a local copy of the latest release build (gitignored).

## The parity invariant

All three implementations must produce **byte-identical XML** and identical `.manifest.csv` files for the same input and options. Only XML line 2 (the comment with the time stamp and time zone label) and line 4 (`<smses ... backup_set=UUID backup_date=...>`) may differ. Any change to conversion logic must be made in all three.

`python3 tests/test_all.py` checks this on the made-up fixture: 4 source layouts × 5 option sets, for the Python, JS and Kotlin engines. The Kotlin engine runs from a JAR built by `./gradlew :core:cliJar`, which needs a JDK 17–24 (it is skipped otherwise). Output goes to `tests/output/`. Then check on the real export too:

```bash
SRC="$(cd "messages-2026-09-08 (recovered)" && pwd)"; OUT="/Volumes/6 Extra Space/Android emulator/work"
python3 cli/sie_to_sbr.py convert "$SRC" "$OUT/py.xml" --tz America/New_York   # refuses to overwrite without --force
node tests/run_js.mjs "$SRC" "$OUT/js.xml" --tz America/New_York        # add --sample for the test set
(cd android && ./gradlew :core:cli -q --args="convert '$SRC' '$OUT/kt.xml' --tz America/New_York")
cmp <(sed '2d;4d' "$OUT/py.xml") <(sed '2d;4d' "$OUT/kt.xml")
cmp "$OUT/py.manifest.csv" "$OUT/kt.manifest.csv"
```

Always pass `--tz`, since `readable_date` otherwise uses the machine's zone. Full outputs are ~800 MB each: write them off the main drive (see Environment) and delete them afterwards. Porting traps already hit:
- JS regex character classes over surrogates (e.g. `[\uD800-\uDBFF][\uDC00-\uDFFF]`) do **not** match the same way in Java/Kotlin regex, which works on code points. Hand-write such checks; see `hasMedia` in `Engine.kt`.
- JS `trim()`/`\s` whitespace and `String(number)` formatting are reproduced explicitly in Kotlin.
- XML-illegal characters are counted per code point, and a lone surrogate counts as one.

## Conversion architecture (same structure in all three)

1. **Load**: parse `messages.ndjson` line by line. Records with `__parts`/`msg_box`/`m_type` are MMS, those with `body`/`address` are SMS, anything else is "bad" (kept with its line number). The JSON keys are SIE's: v2 prefixes added keys with `__`, and v1 does not, so both are accepted.
2. **Plan** (needs the whole export):
   - Detects the phone owner's number: from the sender of sent MMS, otherwise the recipient of most received MMS.
   - For each old `thread_id`, picks the participant list that most of its MMS share. Every MMS in that thread gets this list as its `address`, which is what keeps it in the same conversation when Android restores it.
   - Decides which records can't be converted (`problem()`).
3. **Choose**: all convertible records, or with `sample`, a small representative set (`pickSample`) for a test restore.
4. **Convert**: write elements with attributes in SyncTech's exact order (`SMS_ORDER`/`MMS_ORDER`). A missing value becomes the literal `"null"`, except for the `*_OMIT` fields, which are left out. MMS dates are converted from seconds to ms; attachments are base64 `data` attributes on `<part>`; XML-illegal characters are stripped or replaced and recorded as "changes".
5. **Verify**: re-read the written file with a strict XML parser (Python `iterparse`; on Android, SAX/Expat) and compare every field and every attachment (by SHA-256) with its source record. Also predicts the conversations after restore. The JS version verifies each element in memory instead.
6. **Manifest/report**: `.manifest.csv` has one row per message, with the source line, old ids and SIM id; `.report.txt` is the summary plus the verification result.

## Android app (`android/`)

The hard requirement is that it be **"kosher": no web browsing and no ability to install APKs.** Preserve all of this:
- Zero `<uses-permission>`, no AndroidX/Google/third-party libraries (only `:core` and the Kotlin stdlib), no WebView, no `ACTION_VIEW`/`SEND`/web-search intents, and no selectable text.
- Every `TextView` has `TextClassifier.NO_OP` and no autolink. `EditText` selection menus are filtered down to cut/copy/paste/select-all.
- The only intents are `OPEN_DOCUMENT`/`OPEN_DOCUMENT_TREE`. All file access goes through the Storage Access Framework (`Saf.kt`).
- `./gradlew :app:kosherCheck` builds the release APK and fails if the manifest contains any permission or `<queries>`, or if the dex references WebView, networking, the package installer, or URL/share intents. Run it after every app change.

Structure:
- `Session` is a process-wide singleton holding the state machine (`Start`/`Busy`/`Ready`/`Done`/`Failed`) and runs work on one background thread.
- `MainActivity` rebuilds a programmatic, XML-layout-free view tree from `Session.state`.
- `Saf.kt` opens ZIP files through a `FileChannel` (falling back to a cache copy for non-seekable providers) and folders through tree URIs. `OutputFolder` creates, renames and deletes output documents.

Output safety rules (both came from real bugs):
- The XML is written as `sms-….xml.partial`, verified, and only then renamed to `.xml`.
- Every output is written via `writeSynced`, which calls `fsync` before close. Without it, files were lost on a sudden power-off.
- Some providers (Downloads on Android 8/9) return no display name for the tree root. Folder usability is therefore checked by listing the folder, not by its name.
- Android 11+ pickers refuse the Download root itself, so users need a subfolder.

## Commands

`python3 tests/test_all.py` runs from the repo root. The Gradle commands run from `android/`. The system `java` is JDK 8 and Homebrew's default `openjdk` is 26 (too new for this Gradle/Kotlin), so set `JAVA_HOME` first. `local.properties` points `sdk.dir` at `/opt/homebrew/share/android-commandlinetools` (platform 35, build-tools 35.0.0).

```bash
export JAVA_HOME=/opt/homebrew/opt/openjdk@21
./gradlew :app:kosherCheck                       # release APK (debug-key signed) + offline audit
./gradlew :core:test                             # engine unit tests (JUnit 5)
./gradlew :core:test --tests 'com.smsconverter.sie2sbr.core.EngineTest.verificationCatchesChanges'
./gradlew :core:cli -q --args="convert SOURCE OUT.xml [--sample] [--sub-id unknown|keep|N] [--tz ZONE] [--nul strip|replace] [--owner NUMBERS]"
adb install -r app/build/outputs/apk/release/app-release.apk
```

To try the web app, serve the repo root (`.claude/launch.json` has a `web-app` config on port 8791) and load a backup with `window.sieOpenFile(file)`; with `window.showSaveFilePicker` undefined, the result's blob is in `window.__lastResult`.

Python and JS take the same options: `python3 cli/sie_to_sbr.py {analyze|convert|verify} SOURCE [OUTPUT.xml] [options]` and `node tests/run_js.mjs SOURCE OUT.xml [options]`.

## Environment

- **The main drive is nearly full.** Put large downloads, emulator images and test output on `/Volumes/6 Extra Space`, never on the main drive. Don't use `/Volumes/4 Games:VM's` for tools: the colon in its name breaks colon-separated path lists (the emulator's libraries failed to load there).
- Emulator setup:
  - Location: `/Volumes/6 Extra Space/Android emulator/`, holding the emulator, the API 35 and API 26 arm64 system images, AVDs `sbrtest` (Android 15) and `oreo` (Android 8.0), and `work/` (scratch space plus a copy of the export ZIP).
  - Symlinks: from `/opt/homebrew/share/android-commandlinetools/{emulator,system-images/android-35,system-images/android-26}` and from `~/.android/avd`.
  - Start: set `TMPDIR` to `…/work/tmp/`, then run `$ANDROID_HOME/emulator/emulator -avd sbrtest -no-window -no-audio -no-snapshot -gpu swiftshader_indirect`.
  - Never leave `disk.dataPartition.path=<temp>` in an AVD's `config.ini`: it puts the 10 GB data disk on the main drive.
  - `work/ui.sh` has adb helpers (`ui`, `shot`, `tapText`, `waitFor`) for driving the app headlessly. It is zsh-specific.
