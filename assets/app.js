/* The page: open a backup, show what's in it, choose the new phone's format and what to
 * keep, then create and save the files (one, or several parts). */
(function () {
  'use strict';

  const S = window.SieToSbr;
  const Z = window.SieZip;
  const $ = (id) => document.getElementById(id);
  const state = { src: null, loaded: null, plan: null, busy: false, abort: null };
  const nf = new Intl.NumberFormat();
  const encoder = new TextEncoder();
  const AUTO_SPLIT_MB = 500;  // what browsers without "save straight to disk" can reliably download

  $('version').textContent = S.VERSION;
  $('tz').value = S.localTimeZone();

  // ------------------------------------------------------------------ opening

  function folderFiles(list, pathOf) {
    return Array.from(list, (f) => ({
      path: pathOf(f), size: f.size, read: async () => new Uint8Array(await f.arrayBuffer()),
    }));
  }

  async function open(describe, makeSource) {
    if (state.busy) return;
    const status = $('open-status');
    status.classList.remove('error');
    status.textContent = 'Reading ' + describe + '…';
    ['step-summary', 'step-target', 'step-create'].forEach((id) => { $(id).hidden = true; });
    $('results').innerHTML = '';
    try {
      const src = await makeSource();
      const loaded = await S.load(src);
      if (!loaded.msgs.length) throw new Error('No messages were found in ' + describe + '.');
      state.src = src;
      state.loaded = loaded;
      state.plan = new S.Plan(loaded.msgs, null);
      status.textContent = 'Opened ' + src.label + '.';
      renderSummary();
    } catch (e) {
      status.classList.add('error');
      status.textContent = e.message;
    }
  }

  /** A ZIP file is any backup but SMS Backup & Restore's; anything else is tried as XML. */
  function openFile(file) {
    open('"' + file.name + '"', async () => {
      let zip;
      try {
        zip = await Z.openZip(file);
      } catch (e) {
        return S.sourceFromXmlFile(file, file.name);
      }
      if (!('DecompressionStream' in window)) {
        throw new Error('This browser cannot read ZIP files. Update it, use Chrome, Edge, Firefox or Safari, or unzip the ' +
          'backup and choose the folder instead.');
      }
      return S.sourceFromZip(zip, file.name);
    });
  }

  $('pick-zip').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openFile(file);
  });

  $('pick-folder').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    const label = (files[0].webkitRelativePath || files[0].name).split('/')[0];
    open('the folder "' + label + '"', async () => S.sourceFromFiles(folderFiles(files, (f) => f.webkitRelativePath || f.name), label));
  });

  // Drag and drop: a backup file, or a whole folder.
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, () => drop.classList.remove('over')));
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  drop.addEventListener('drop', async (e) => {
    e.preventDefault();
    const item = e.dataTransfer.items && e.dataTransfer.items[0];
    const entry = item && item.webkitGetAsEntry ? item.webkitGetAsEntry() : null;
    if (entry && entry.isDirectory) {
      open('the folder "' + entry.name + '"', async () => {
        const files = await walk(entry);
        return S.sourceFromFiles(folderFiles(files, (f) => f._path), entry.name);
      });
    } else if (e.dataTransfer.files[0]) {
      openFile(e.dataTransfer.files[0]);
    }
  });

  async function walk(dir) {
    const out = [];
    const readAll = (reader) => new Promise((resolve, reject) => {
      const all = [];
      const next = () => reader.readEntries((batch) => (batch.length ? (all.push(...batch), next()) : resolve(all)), reject);
      next();
    });
    for (const entry of await readAll(dir.createReader())) {
      if (entry.isDirectory) out.push(...await walk(entry));
      else {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        file._path = entry.fullPath.replace(/^\//, '');
        out.push(file);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ summary

  function day(ms) {
    return ms === null ? '?' : new Date(Number(ms)).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function stat(label, value, detail) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = value;
    if (detail) {
      const small = document.createElement('small');
      small.textContent = detail;
      dd.appendChild(small);
    }
    div.append(dt, dd);
    return div;
  }

  const FORMAT_NAMES = { sie: 'Fig / TAK', sbr: 'SMS Backup & Restore', wonder: 'Wonder', pom: 'Pom', buggy: 'Buggy Backup' };

  function renderSummary() {
    const s = S.summarize(state.src, state.loaded, state.plan);
    const fmt = state.src.format;
    $('stats').replaceChildren(
      stat('Backup from', FORMAT_NAMES[fmt], fmt === 'sie' ? 'SMS Import / Export' : fmt === 'buggy' ? 'texts only' : ''),
      stat('Text messages (SMS)', nf.format(s.sms), nf.format(s.smsReceived) + ' received, ' + nf.format(s.smsSent) + ' sent'),
      stat('Picture/group messages (MMS)', nf.format(s.mms), nf.format(s.mmsReceived) + ' received, ' + nf.format(s.mmsSent) + ' sent'),
      stat('Attachments', nf.format(s.present), s.missing ? nf.format(s.missing) + ' missing from the backup' : 'photos, videos, audio, contacts'),
      stat('Conversations', nf.format(s.conversations), day(s.first) + ' – ' + day(s.last)),
      stat('Your number', s.owner.join(', ') || 'not found', s.owner.length ? 'detected from ' + (s.ownerHow.startsWith('the sender') ? 'sent MMS' : 'received MMS') : 'set it under More options'));
    const notes = [];
    if (s.problems.length || s.bad.length) {
      notes.push(['warn', nf.format(s.problems.length + s.bad.length) + ' record(s) cannot be converted (missing date, address or type, or unreadable); the report lists them.']);
    }
    if (s.empty) notes.push(['warn', nf.format(s.empty) + ' attachment file(s) are empty in the backup itself; those pictures cannot be recovered.']);
    if (s.missing) notes.push(['warn', nf.format(s.missing) + ' attachment file(s) are missing from the backup; those messages are kept without them.']);
    if (!s.owner.length && s.mms) notes.push(['warn', 'Your own number could not be detected, which matters for group chats. Enter it under More options.']);
    notes.push(['', 'Old SIM ids will be written as "unknown" so the messages show up on Android 14 and later (see More options).']);
    $('summary-notes').replaceChildren(...notes.map(([cls, text]) => {
      const li = document.createElement('li');
      li.className = cls;
      li.textContent = text;
      return li;
    }));
    $('owner').placeholder = s.owner.length ? 'detected: ' + s.owner.join(', ') + ' (enter the full number to change)' : 'e.g. +1 555 010 0000';
    $('save-hint').textContent = window.showSaveFilePicker
      ? 'You will be asked where to save each file.'
      : 'Each file is saved to your Downloads folder. For very large backups, Chrome or Edge on a computer works best.';
    // Fig and TAK use the same format: suggest a different target when the backup is one.
    if (fmt === 'sie' && checked('to') === 'fig') document.querySelector('input[name="to"][value="sbr"]').checked = true;
    targetChanged();
    ['step-summary', 'step-target', 'step-create'].forEach((id) => { $(id).hidden = false; });
  }

  // ------------------------------------------------------------------ options

  const checked = (name) => document.querySelector('input[name="' + name + '"]:checked').value;

  function readOptions(sample) {
    const subMode = checked('subid');
    let subId = subMode;
    if (subMode === 'custom') {
      subId = $('subid-custom').value.trim();
      if (!/^-?[0-9]+$/.test(subId)) throw new Error('Enter a whole number for the SIM id, or pick another SIM option.');
    }
    const tz = $('tz').value.trim() || null;
    const tzError = S.checkTimeZone(tz);
    if (tzError) throw new Error(tzError);
    let splitMb = 0;
    if ($('split').checked) {
      splitMb = Number($('split-mb').value);
      if (!(splitMb > 0)) throw new Error('Enter how many MB each part may have.');
    }
    return {
      to: checked('to'), sample, keep: checked('keep'), noGroups: $('no-groups').checked, noPdf: $('no-pdf').checked,
      splitMb, subId, tz, nul: checked('nul'), owner: $('owner').value.trim() || null, verify: $('verify').checked,
    };
  }

  const RESTORE = {
    sbr: ['Install <strong>SMS Backup &amp; Restore</strong> (by SyncTech) and open it. On the MindPhone it is already there.',
      'In its <em>Settings → Backup settings → Local backup folder</em>, choose or create a folder, for example <code>SMSBackupRestore</code>.',
      'Copy the file you created into that folder on the phone (USB cable, a USB stick, or the phone\'s Files app). Keep the name starting with <code>sms-</code>.',
      'Optional: <em>Menu → View backups</em> shows what\'s in the file without changing anything.',
      'Tap <em>Restore</em>, pick the file, tick <em>Messages</em> and start. Allow the app to be your SMS app while it restores, then switch back to your usual messaging app.'],
    fig: ['Copy the <code>messages-….zip</code> file you created to the Fig or TAK phone (USB cable, a USB stick, or the phone\'s Files app). Don\'t unzip it.',
      'Open the phone\'s message backup / restore screen (SMS Import / Export) and choose <em>Import</em>.',
      'Pick the file and let it finish. Allow it to be your SMS app while it imports, if it asks.'],
    wonder: ['Copy the <code>Messages_Backup_….zip</code> file you created to the Wonder phone (USB cable, a USB stick, or the phone\'s Files app). Don\'t unzip it.',
      'Open the Wonder\'s message backup screen and choose <em>Restore</em>.',
      'Pick the file and let it finish.'],
  };

  function targetChanged() {
    const to = checked('to');
    const fromSie = state.src && state.src.format === 'sie';
    $('target-hint').textContent = to === 'fig' && fromSie
      ? 'This backup is already a Fig / TAK backup: it can be restored on a Fig or TAK as it is. Convert it only to leave things out.'
      : to === 'wonder' ? 'Wonder backups keep the main parts of each message (texts, dates, pictures, group members).' : '';
    $('restore-steps').innerHTML = RESTORE[to].concat(['Do the test file first. Check names, times, sent/received sides, photos and ' +
      'group chats. Then restore the full backup the same way.']).map((s) => '<li>' + s + '</li>').join('');
  }
  document.querySelectorAll('input[name="to"]').forEach((r) => r.addEventListener('change', targetChanged));
  targetChanged();

  // ------------------------------------------------------------------ saving

  /** Writes to a file on disk (Chrome, Edge). Accepts text and bytes. */
  function fileSink(writable, name) {
    let pending = [], size = 0;
    const sink = {
      name, bytes: 0, download: null,
      async flush() {
        if (!pending.length) return;
        const data = encoder.encode(pending.join(''));
        pending = [];
        size = 0;
        sink.bytes += data.length;
        await writable.write(data);
      },
      async write(s) {
        if (typeof s === 'string') {
          pending.push(s);
          size += s.length;
          if (size > 4 << 20) await sink.flush();
        } else {
          await sink.flush();
          sink.bytes += s.length;
          await writable.write(s);
        }
      },
      async close() { await sink.flush(); await writable.close(); },
      async abort() { try { await writable.abort(); } catch (e) { /* already closed */ } },
    };
    return sink;
  }

  /** Builds the file in memory in pieces, then downloads it (Safari, Firefox, phones). */
  function blobSink(name, type) {
    let pending = [], chunk = [], chunkBytes = 0;
    const blobs = [];
    const sink = {
      name, bytes: 0, download: null,
      flush() {
        if (pending.length) {
          const data = encoder.encode(pending.join(''));
          pending = [];
          chunk.push(data);
          chunkBytes += data.length;
          sink.bytes += data.length;
        }
        if (chunkBytes > 32 << 20) {
          blobs.push(new Blob(chunk));
          chunk = [];
          chunkBytes = 0;
        }
      },
      async write(s) {
        if (typeof s === 'string') {
          pending.push(s);
          if (pending.length > 2000) sink.flush();
        } else {
          sink.flush();
          chunk.push(s);
          chunkBytes += s.length;
          sink.bytes += s.length;
          sink.flush();
        }
      },
      async close() {
        sink.flush();
        blobs.push(new Blob(chunk));
        sink.blob = new Blob(blobs, { type });
        sink.download = () => download(sink.blob, name, 120000);
      },
      async abort() {},
    };
    return sink;
  }

  function download(blob, name, keepMs) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), keepMs || 60000);
  }

  const MIME = { sbr: 'text/xml', fig: 'application/zip', wonder: 'application/zip' };
  const PICKER_TYPES = { sbr: { description: 'SMS Backup & Restore file', accept: { 'text/xml': ['.xml'] } },
    fig: { description: 'Fig / TAK backup', accept: { 'application/zip': ['.zip'] } },
    wonder: { description: 'Wonder backup', accept: { 'application/zip': ['.zip'] } } };

  /** One file: saved where the user picks (Chrome, Edge) or downloaded. null: the user closed the dialog. */
  async function openSink(name, to) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [PICKER_TYPES[to]] });
        return fileSink(await handle.createWritable(), handle.name);
      } catch (e) {
        if (e.name === 'AbortError') return null;
      }
    }
    return blobSink(name, MIME[to]);
  }

  /** The names SMS Backup & Restore, SMS Import / Export and Wonder use for their backups. */
  function fileName(to, sample, now) {
    const p = (n) => String(n).padStart(2, '0');
    const ymd = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
    if (to === 'sbr') return (sample ? 'sms-test-' : 'sms-') + S.fileStamp(now) + '.xml';
    if (to === 'fig') return (sample ? 'messages-test-' : 'messages-') + ymd + '.zip';
    return (sample ? 'Messages_Backup_test_' : 'Messages_Backup_') + ymd + '.zip';
  }

  function saveText(text, name, type) {
    download(new Blob([text], { type }), name);
  }

  // ------------------------------------------------------------------ creating

  function setBusy(busy) {
    state.busy = busy;
    ['make-test', 'make-full', 'pick-zip', 'pick-folder'].forEach((id) => { $(id).disabled = busy; });
    $('progress').hidden = !busy;
  }

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));

  async function create(sample) {
    if (state.busy || !state.loaded) return;
    let options;
    try {
      options = readOptions(sample);
    } catch (e) {
      showError(e.message);
      return;
    }
    const now = new Date();
    let job = S.prepare({ src: state.src, loaded: state.loaded, options, now });
    let autoSplit = false;
    if (!window.showSaveFilePicker && !options.splitMb && S.estimateTotal(job) > AUTO_SPLIT_MB * 1048576) {
      job = S.prepare({ src: state.src, loaded: state.loaded, options: Object.assign({}, options, { splitMb: AUTO_SPLIT_MB }), now });
      autoSplit = true;
    }
    if (!job.chosen.length) {
      showError('Nothing to save: no message is left with these "what to keep" choices.');
      return;
    }
    const name = fileName(options.to, sample, now);
    const ext = name.slice(name.lastIndexOf('.')), stem = name.slice(0, -ext.length);
    const n = job.parts.length;
    const names = n === 1 ? [name] : job.parts.map((_, k) => stem + '-part' + (k + 1) + ext);
    let dir = null, sink = null;
    if (n === 1) {
      sink = await openSink(name, options.to);
      if (!sink) return;
    } else if (window.showDirectoryPicker) {
      try {
        dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'sms-backup-parts' });
      } catch (e) {
        if (e.name === 'AbortError') return;
      }
    }
    state.abort = new AbortController();
    setBusy(true);
    $('bar').style.width = '0';
    $('progress-text').textContent = 'Starting…';
    const files = [];
    try {
      if (options.to === 'sbr' && options.verify) S.checkProlog(null, options);
      for (let k = 0; k < n; k++) {
        let s = sink;
        if (n > 1) {
          s = dir ? fileSink(await (await dir.getFileHandle(names[k], { create: true })).createWritable(), names[k])
            : blobSink(names[k], MIME[options.to]);
        }
        let last = 0;
        const { verification } = await S.writePart(job, k, s, {
          signal: state.abort.signal,
          onProgress: async (done, total) => {
            const t = performance.now();
            if (t - last < 120 && done < total) return;
            last = t;
            $('bar').style.width = (100 * (k + done / total) / n).toFixed(1) + '%';
            $('progress-text').textContent = (n > 1 ? 'Part ' + (k + 1) + ' of ' + n + ': ' : '') +
              (options.to === 'sbr' ? 'writing message ' : 'adding attachment ') + nf.format(done) + ' of ' + nf.format(total) + '…';
            await pause(0);
          },
        });
        files.push({ name: s.name, bytes: s.bytes, verification, sink: s, msgs: job.parts[k] });
        if (n > 1 && s.download) {
          s.download();
          if (k + 1 < n) {
            $('progress-text').textContent = 'Part ' + (k + 1) + ' is downloading; part ' + (k + 2) + ' comes next…';
            await pause(2500);
          }
        }
      }
      showResult(job, files, sample, { dir, autoSplit });
    } catch (e) {
      for (const f of files.concat(sink ? [{ sink }] : [])) await f.sink.abort();
      if (e.name === 'AbortError') showError('Cancelled. Nothing more was saved.');
      else showError('Something went wrong: ' + e.message);
    } finally {
      setBusy(false);
      state.abort = null;
    }
  }

  function showError(text) {
    const div = document.createElement('div');
    div.className = 'result bad';
    const h = document.createElement('h3');
    h.textContent = text;
    div.appendChild(h);
    $('results').prepend(div);
  }

  function button(text, onClick, primary) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'button small' + (primary ? ' primary' : '');
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
  }

  const sizeText = (bytes) => (bytes < 1048576 ? Math.max(1, Math.round(bytes / 1024)) + ' KB' : (bytes / 1048576).toFixed(1) + ' MB');

  function showResult(job, files, sample, { dir, autoSplit }) {
    const failed = files.some((f) => f.verification && !f.verification.ok);
    const checkedAll = files.every((f) => f.verification);
    const div = document.createElement('div');
    div.className = 'result ' + (failed ? 'bad' : 'ok');
    const h = document.createElement('h3');
    const count = nf.format(job.chosen.length);
    const what = { sbr: 'SMS Backup & Restore', fig: 'Fig / TAK', wonder: 'Wonder' }[job.options.to];
    h.textContent = failed ? 'The check found problems - see the report before using these files'
      : (sample ? 'Test file ready: ' : what + ' backup ready: ') + count + ' messages' + (checkedAll ? ', every one checked' : '') +
        (files.length > 1 ? ', in ' + files.length + ' parts' : '');
    div.appendChild(h);
    for (const f of files) {
      const p = document.createElement('p');
      p.textContent = f.name + ' · ' + sizeText(f.bytes) +
        (f.verification && f.verification.conversations ? ' · conversations after restore: ' + nf.format(f.verification.conversations) : '') +
        (f.sink.download ? ' · saved to your Downloads folder' : ' · saved where you chose');
      div.appendChild(p);
    }
    const c = job.conv;
    const notes = [];
    if (files.length > 1) notes.push((autoSplit ? 'This backup is big, so it was saved as ' : 'Saved as ') + files.length + ' parts. Restore them in order, part 1 first.');
    if (dir) notes.push('All parts, the report and the message lists are in the folder you chose.');
    if (job.leftOut.mms || job.leftOut.sms || job.leftOut.groups || job.leftOut.pdf) {
      notes.push('Left out as you chose: ' + [job.leftOut.mms && job.leftOut.mms + ' MMS', job.leftOut.sms && job.leftOut.sms + ' SMS',
        job.leftOut.groups && job.leftOut.groups + ' group messages', job.leftOut.pdf && job.leftOut.pdf + ' PDF files'].filter(Boolean).join(', ') + '.');
    }
    if (c.changes.length) notes.push(c.changes.length + ' message field(s) contained characters a backup file cannot store; they were ' + (job.options.nul === 'strip' ? 'removed' : 'replaced by �') + '.');
    if (c.stats.mms_address_from_conversation) notes.push(c.stats.mms_address_from_conversation + ' group message(s) list fewer people than their group; they are kept in that group.');
    if (c.stats.attachments_empty) notes.push(c.stats.attachments_empty + ' attachment(s) were already empty in the backup.');
    if (c.stats.attachments_missing) notes.push(c.stats.attachments_missing + ' attachment(s) were missing from the backup.');
    const split = files.reduce((a, f) => a + (f.verification && f.verification.split ? f.verification.split.length : 0), 0);
    if (split) notes.push(split + ' old conversation(s) will appear split in two (details in the report).');
    if (job.problems.length + job.loaded.bad.length) notes.push(job.problems.length + job.loaded.bad.length + ' record(s) could not be converted (listed in the report).');
    for (const text of notes) {
      const p = document.createElement('p');
      p.textContent = '• ' + text;
      div.appendChild(p);
    }
    const base = files.length > 1 ? files[0].name.replace(/-part1(\.[a-z]+)$/, '$1') : files[0].name;
    const reportName = base.replace(/\.(xml|zip)$/, '.report.txt');
    const reportText = S.report(job, files.map((f) => ({ name: f.name, bytes: f.bytes, verification: f.verification })));
    const manifests = files.map((f) => [f.name.replace(/\.(xml|zip)$/, '.manifest.csv'), S.manifest(job, f.msgs)]);
    if (dir) {
      (async () => {
        for (const [n, text] of [[reportName, reportText]].concat(manifests)) {
          const w = await (await dir.getFileHandle(n, { create: true })).createWritable();
          await w.write(text);
          await w.close();
        }
      })().catch((e) => showError('The report could not be saved in the folder: ' + e.message));
    }
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    for (const f of files) {
      if (f.sink.download) buttons.appendChild(button('Download ' + f.name + ' again', f.sink.download, files.length === 1));
    }
    buttons.appendChild(button('Save report', () => saveText(reportText, reportName, 'text/plain')));
    for (const [n, text] of manifests) {
      buttons.appendChild(button(manifests.length > 1 ? 'Save message list ' + n.replace(/^.*-part(\d+).*$/, '(part $1)') : 'Save message list (CSV)',
        () => saveText(text, n, 'text/csv')));
    }
    div.appendChild(buttons);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Show the full report';
    const pre = document.createElement('pre');
    pre.textContent = reportText;
    details.append(summary, pre);
    div.appendChild(details);
    $('results').prepend(div);
    if (files.length === 1 && files[0].sink.download) files[0].sink.download();
    window.__lastResult = { name: files[0].name, bytes: files[0].bytes, blob: files[0].sink.blob || null, ok: !failed, report: reportText,
      files: files.map((f) => ({ name: f.name, bytes: f.bytes, blob: f.sink.blob || null })) };
  }

  $('make-test').addEventListener('click', () => create(true));
  $('make-full').addEventListener('click', () => create(false));
  $('cancel').addEventListener('click', () => state.abort && state.abort.abort());
  window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });

  // Lets tests (and power users) open a backup from script: window.sieOpenFile(file).
  window.sieOpenFile = (file) => openFile(file);
})();
