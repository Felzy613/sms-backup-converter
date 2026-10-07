/* The page: open a backup, show what's in it, create and save the XML files. */
(function () {
  'use strict';

  const S = window.SieToSbr;
  const Z = window.SieZip;
  const $ = (id) => document.getElementById(id);
  const state = { src: null, loaded: null, plan: null, busy: false, abort: null };
  const nf = new Intl.NumberFormat();
  const encoder = new TextEncoder();

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
    $('step-summary').hidden = true;
    $('step-create').hidden = true;
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

  $('pick-zip').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) openZip(file);
  });

  $('pick-folder').addEventListener('change', (e) => {
    const files = Array.from(e.target.files);
    e.target.value = '';
    if (!files.length) return;
    const label = (files[0].webkitRelativePath || files[0].name).split('/')[0];
    open('the folder "' + label + '"', async () => S.sourceFromFiles(folderFiles(files, (f) => f.webkitRelativePath || f.name), label));
  });

  function openZip(file) {
    if (!('DecompressionStream' in window)) {
      $('open-status').classList.add('error');
      $('open-status').textContent = 'This browser cannot read ZIP files. Update it, use Chrome, Edge, Firefox or Safari, or unzip the backup and choose the folder instead.';
      return;
    }
    open('"' + file.name + '"', async () => S.sourceFromZip(await Z.openZip(file), file.name));
  }

  // Drag and drop: a ZIP file, or a whole folder.
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
      openZip(e.dataTransfer.files[0]);
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

  function renderSummary() {
    const s = S.summarize(state.src, state.loaded, state.plan);
    const stats = $('stats');
    stats.replaceChildren(
      stat('Text messages (SMS)', nf.format(s.sms), nf.format(s.smsReceived) + ' received, ' + nf.format(s.smsSent) + ' sent'),
      stat('Picture/group messages (MMS)', nf.format(s.mms), nf.format(s.mmsReceived) + ' received, ' + nf.format(s.mmsSent) + ' sent'),
      stat('Attachments', nf.format(s.present), s.missing ? nf.format(s.missing) + ' missing from the backup' : 'photos, videos, audio, contacts'),
      stat('Conversations', nf.format(s.conversations), day(s.first) + ' – ' + day(s.last)),
      stat('Your number', s.owner.join(', ') || 'not found', s.owner.length ? 'detected from ' + (s.ownerHow.startsWith('the sender') ? 'sent MMS' : 'received MMS') : 'set it under Options'));
    const notes = [];
    if (s.problems.length || s.bad.length) {
      notes.push(['warn', nf.format(s.problems.length + s.bad.length) + ' record(s) cannot be converted (missing date, address or type, or unreadable); the report lists them.']);
    }
    if (s.empty) notes.push(['warn', nf.format(s.empty) + ' attachment file(s) are empty in the backup itself; those pictures cannot be recovered.']);
    if (s.missing) notes.push(['warn', nf.format(s.missing) + ' attachment file(s) are missing from the backup; those messages are kept without them.']);
    if (!s.owner.length) notes.push(['warn', 'Your own number could not be detected, which matters for group chats. Enter it under Options.']);
    notes.push(['', 'Old SIM ids will be written as "unknown" so the messages show up on Android 14 and later (see Options).']);
    $('summary-notes').replaceChildren(...notes.map(([cls, text]) => {
      const li = document.createElement('li');
      li.className = cls;
      li.textContent = text;
      return li;
    }));
    $('owner').placeholder = s.owner.length ? 'detected: ' + s.owner.join(', ') + ' (enter the full number to change)' : 'e.g. +1 555 010 0000';
    $('make-full').textContent = 'Create full backup (' + nf.format(state.loaded.msgs.length - s.problems.length) + ' messages)';
    $('save-hint').textContent = window.showSaveFilePicker
      ? 'You will be asked where to save each file.'
      : 'Each file is saved to your Downloads folder. For very large backups, Chrome or Edge on a computer works best.';
    $('step-summary').hidden = false;
    $('step-create').hidden = false;
  }

  // ------------------------------------------------------------------ options

  function readOptions(sample) {
    const subMode = document.querySelector('input[name="subid"]:checked').value;
    let subId = subMode;
    if (subMode === 'custom') {
      subId = $('subid-custom').value.trim();
      if (!/^-?[0-9]+$/.test(subId)) throw new Error('Enter a whole number for the SIM id, or pick another SIM option.');
    }
    const tz = $('tz').value.trim() || null;
    const tzError = S.checkTimeZone(tz);
    if (tzError) throw new Error(tzError);
    return {
      sample, subId, tz,
      nul: document.querySelector('input[name="nul"]:checked').value,
      owner: $('owner').value.trim() || null,
    };
  }

  // ------------------------------------------------------------------ saving

  /** Writes to a file the user picked (Chrome, Edge): the file goes straight to disk. */
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
      async write(s) { pending.push(s); size += s.length; if (size > 4 << 20) await sink.flush(); },
      async close() { await sink.flush(); await writable.close(); },
      async abort() { try { await writable.abort(); } catch (e) { /* already closed */ } },
    };
    return sink;
  }

  /** Builds the file in memory in pieces, then downloads it (Safari, Firefox, phones). */
  function blobSink(name) {
    let pending = [], size = 0, chunk = [], chunkBytes = 0;
    const blobs = [];
    const sink = {
      name, bytes: 0, download: null,
      flush() {
        if (pending.length) {
          const data = encoder.encode(pending.join(''));
          pending = [];
          size = 0;
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
      async write(s) { pending.push(s); size += s.length; if (size > 4 << 20) sink.flush(); },
      async close() {
        sink.flush();
        blobs.push(new Blob(chunk));
        sink.blob = new Blob(blobs, { type: 'text/xml' });
        sink.download = () => {
          const a = document.createElement('a');
          a.href = URL.createObjectURL(sink.blob);
          a.download = name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 120000);
        };
      },
      async abort() {},
    };
    return sink;
  }

  async function openSink(name) {
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: name,
          types: [{ description: 'SMS Backup & Restore file', accept: { 'text/xml': ['.xml'] } }] });
        return fileSink(await handle.createWritable(), handle.name);
      } catch (e) {
        if (e.name === 'AbortError') return null;  // the user closed the dialog
      }
    }
    return blobSink(name);
  }

  function saveText(text, name, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }

  // ------------------------------------------------------------------ creating

  function setBusy(busy) {
    state.busy = busy;
    ['make-test', 'make-full', 'pick-zip', 'pick-folder'].forEach((id) => { $(id).disabled = busy; });
    $('progress').hidden = !busy;
  }

  async function create(sample) {
    if (state.busy || !state.loaded) return;
    let options;
    try {
      options = readOptions(sample);
    } catch (e) {
      showError(e.message);
      return;
    }
    const plan = options.owner ? new S.Plan(state.loaded.msgs, options.owner) : state.plan;
    const name = (sample ? 'sms-test-' : 'sms-') + S.fileStamp(new Date()) + '.xml';
    const sink = await openSink(name);
    if (!sink) return;
    const verify = $('verify').checked;
    const verifier = verify ? new S.Verifier(plan, options) : null;
    state.abort = new AbortController();
    setBusy(true);
    $('bar').style.width = '0';
    $('progress-text').textContent = 'Starting…';
    let last = 0;
    try {
      if (verify) S.checkProlog(null, options);
      const result = await S.convert({
        src: state.src, loaded: state.loaded, plan, options, sink, verifier, signal: state.abort.signal,
        onProgress: async (done, total) => {
          const now = performance.now();
          if (now - last < 120 && done < total) return;
          last = now;
          $('bar').style.width = (100 * done / total).toFixed(1) + '%';
          $('progress-text').textContent = 'Writing message ' + nf.format(done) + ' of ' + nf.format(total) + '…';
          await new Promise((r) => setTimeout(r, 0));
        },
      });
      showResult(result, sink, sample);
    } catch (e) {
      await sink.abort();
      if (e.name === 'AbortError') showError('Cancelled. Nothing was saved.');
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

  function showResult(result, sink, sample) {
    const v = result.verification;
    const failed = v && !v.ok;
    const div = document.createElement('div');
    div.className = 'result ' + (failed ? 'bad' : 'ok');
    const h = document.createElement('h3');
    const count = nf.format(result.chosen.length);
    h.textContent = failed ? 'The check found problems - see the report before using ' + sink.name
      : (sample ? 'Test file ready: ' : 'Full backup ready: ') + count + ' messages' + (v ? ', every one checked' : '');
    const p = document.createElement('p');
    const size = sink.bytes < 1048576 ? Math.max(1, Math.round(sink.bytes / 1024)) + ' KB' : (sink.bytes / 1048576).toFixed(1) + ' MB';
    p.textContent = sink.name + ' · ' + size +
      (v ? ' · expected conversations after restore: ' + nf.format(v.conversations) : '') +
      (sink.download ? ' · saving to your Downloads folder' : ' · saved where you chose');
    div.append(h, p);
    const c = result.conv;
    const notes = [];
    if (c.changes.length) notes.push(c.changes.length + ' message field(s) contained characters a backup file cannot store; they were ' + (result.options.nul === 'strip' ? 'removed' : 'replaced by �') + '.');
    if (c.stats.mms_address_from_conversation) notes.push(c.stats.mms_address_from_conversation + ' group message(s) list fewer people than their group; they are kept in that group.');
    if (c.stats.attachments_empty) notes.push(c.stats.attachments_empty + ' attachment(s) were already empty in the backup.');
    if (c.stats.attachments_missing) notes.push(c.stats.attachments_missing + ' attachment(s) were missing from the backup.');
    if (v && v.split.length) notes.push(v.split.length + ' old conversation(s) will appear split in two (details in the report).');
    if (result.problems.length + result.loaded.bad.length) notes.push(result.problems.length + result.loaded.bad.length + ' record(s) could not be converted (listed in the report).');
    for (const text of notes) {
      const n = document.createElement('p');
      n.textContent = '• ' + text;
      div.appendChild(n);
    }
    const reportText = S.report(result, sink.name, sink.bytes);
    const buttons = document.createElement('div');
    buttons.className = 'buttons';
    if (sink.download) buttons.appendChild(button('Download ' + sink.name + ' again', sink.download, true));
    buttons.appendChild(button('Save report', () => saveText(reportText, sink.name.replace(/\.xml$/, '.report.txt'), 'text/plain')));
    buttons.appendChild(button('Save message list (CSV)', () => saveText(S.manifest(result), sink.name.replace(/\.xml$/, '.manifest.csv'), 'text/csv')));
    div.appendChild(buttons);
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Show the full report';
    const pre = document.createElement('pre');
    pre.textContent = reportText;
    details.append(summary, pre);
    div.appendChild(details);
    $('results').prepend(div);
    if (sink.download) sink.download();
    window.__lastResult = { name: sink.name, bytes: sink.bytes, blob: sink.blob || null, ok: !failed, report: reportText };
  }

  $('make-test').addEventListener('click', () => create(true));
  $('make-full').addEventListener('click', () => create(false));
  $('cancel').addEventListener('click', () => state.abort && state.abort.abort());
  window.addEventListener('beforeunload', (e) => { if (state.busy) e.preventDefault(); });

  // Lets tests (and power users) open a backup from script: window.sieOpenFile(file).
  window.sieOpenFile = (file) => openZip(file);
})();
