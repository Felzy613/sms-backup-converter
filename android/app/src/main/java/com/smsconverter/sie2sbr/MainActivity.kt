package com.smsconverter.sie2sbr

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.res.ColorStateList
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.ActionMode
import android.view.Gravity
import android.view.Menu
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowManager
import android.view.textclassifier.TextClassifier
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.RadioButton
import android.widget.RadioGroup
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import com.smsconverter.sie2sbr.Session.fmt
import com.smsconverter.sie2sbr.core.Options
import com.smsconverter.sie2sbr.core.isInt
import com.smsconverter.sie2sbr.core.localTimeZone
import java.math.BigInteger
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.roundToInt

/** The only screen. It is rebuilt from Session.state whenever that changes.
 *
 *  Nothing here can open a web page: no WebView, no links (auto-linking and the text
 *  classifier are off on every text view), text cannot be selected (so there is no "Web
 *  search" or "Share" action), and the only intents started are the system file pickers. */
class MainActivity : Activity() {
    private lateinit var scroll: ScrollView
    private lateinit var content: LinearLayout
    private val prefs by lazy { getSharedPreferences("settings", MODE_PRIVATE) }
    private var pendingSample: Boolean? = null  // convert once the save folder is chosen
    private var busyViews: BusyViews? = null

    private class BusyViews(val title: TextView, val bar: ProgressBar, val detail: TextView, val cancel: Button?)

    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        if (state != null && state.containsKey("pending")) pendingSample = state.getBoolean("pending")
        scroll = ScrollView(this).apply {
            isFillViewport = true
            setBackgroundColor(color(R.color.bg))
        }
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(32))
        }
        scroll.addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(scroll)
        if (Build.VERSION.SDK_INT >= 30) {
            @Suppress("DEPRECATION") window.setDecorFitsSystemWindows(false)
            scroll.setOnApplyWindowInsetsListener { v, insets ->
                val i = insets.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime() or WindowInsets.Type.displayCutout())
                v.setPadding(i.left, i.top, i.right, i.bottom)
                WindowInsets.CONSUMED
            }
        }
    }

    override fun onSaveInstanceState(out: Bundle) {
        super.onSaveInstanceState(out)
        pendingSample?.let { out.putBoolean("pending", it) }
    }

    override fun onResume() {
        super.onResume()
        Session.listener = { render() }
        render()
    }

    override fun onPause() {
        super.onPause()
        Session.listener = null
    }

    @Deprecated("Deprecated in Java")
    override fun onBackPressed() {
        when (val s = Session.state) {
            is Session.Busy -> if (s.cancellable) confirmCancel()
            is Session.Ready -> Session.reset()
            is Session.Done, is Session.Failed -> Session.backToReady()
            else -> @Suppress("DEPRECATION") super.onBackPressed()
        }
    }

    // ----------------------------------------------------------------------- screens

    private fun render() {
        val s = Session.state
        if (s is Session.Busy) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        val bv = busyViews
        if (s is Session.Busy && bv != null && (bv.cancel != null) == s.cancellable) {
            updateBusy(bv, s)  // just move the progress bar
            return
        }
        busyViews = null
        content.removeAllViews()
        header()
        when (s) {
            is Session.Start -> start()
            is Session.Busy -> busy(s)
            is Session.Ready -> ready()
            is Session.Done -> done(s)
            is Session.Failed -> failed(s)
        }
    }

    private fun header() {
        text(content, getString(R.string.app_name), 24f, bold = true)
        text(content, "Fig · TAK · Wonder · Pom · Buggy Backup · SMS Backup & Restore", 14f, R.color.muted, top = 2)
    }

    private fun start() {
        val c = card()
        text(c, "Move your messages to another phone", 18f, bold = true)
        text(c, "This turns the message backup of your old phone into one your new phone can restore, even when the " +
            "two phones use different formats: Fig, TAK, Wonder, Pom, Buggy Backup, or SMS Backup & Restore (any " +
            "Android phone, including the MindPhone).", top = 8)
        text(c, "Everything happens on this phone. This app has no internet access, and your backup is only read, " +
            "never changed.", 14f, R.color.muted, top = 8)
        button(content, "Choose the backup file", primary = true, top = 20) { pickZip() }
        button(content, "Choose an unzipped Fig or TAK folder", primary = false, top = 10) { pickFolder() }
        text(content, "The backup file is a .zip file (Fig, TAK, Wonder, Pom, Buggy Backup) or an SMS Backup & Restore " +
            ".xml file. Use the folder option only if a Fig or TAK backup was unzipped: choose the folder that contains " +
            "messages.ndjson.", 13f, R.color.muted, top = 10)
    }

    private fun busy(s: Session.Busy) {
        val c = card()
        val title = text(c, s.title, 18f, bold = true)
        val bar = ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal).apply {
            max = 1000
            progressTintList = ColorStateList.valueOf(color(R.color.primary))
            indeterminateTintList = progressTintList
        }
        c.addView(bar, lp(top = 14))
        val detail = text(c, s.detail, 14f, R.color.muted, top = 6)
        text(c, "Keep this screen open. A large backup can take several minutes.", 13f, R.color.muted, top = 14)
        val cancel = if (s.cancellable) button(content, "Cancel", primary = false, top = 16) { confirmCancel() } else null
        busyViews = BusyViews(title, bar, detail, cancel).also { updateBusy(it, s) }
    }

    private fun updateBusy(v: BusyViews, s: Session.Busy) {
        v.title.text = s.title
        v.detail.text = s.detail
        v.bar.isIndeterminate = s.fraction == null
        if (s.fraction != null) v.bar.progress = (s.fraction * 1000).roundToInt().coerceIn(0, 1000)
    }

    private fun ready() {
        val s = Session.summary ?: return start()
        val src = Session.source
        val c = card()
        text(c, "Backup from " + (FORMAT_NAMES[src?.format] ?: ""), 13f, R.color.muted, bold = true)
        text(c, src?.label ?: "", 17f, bold = true, top = 2)
        val dates = listOfNotNull(day(s.first), day(s.last))
        if (dates.size == 2) text(c, "${dates[0]}  to  ${dates[1]}", 14f, R.color.muted, top = 2)
        fact(c, fmt(s.sms), "text messages (SMS)")
        fact(c, fmt(s.mms), "picture and group messages (MMS)")
        fact(c, fmt(s.present), "attachments" + if (s.missing > 0) " (${fmt(s.missing)} missing from the backup)" else "")
        fact(c, fmt(s.conversations), "conversations")
        val owner = Session.options.owner
        when {
            !owner.isNullOrBlank() -> text(c, "Your number: $owner (entered by you)", 14f, top = 10)
            s.owner.isNotEmpty() -> text(c, "Your number: " + s.owner.joinToString(", ") + " (found in the backup)", 14f, top = 10)
            s.mms > 0 -> text(c, "Your number was not found in the backup. Group messages may be filed under the wrong " +
                "conversation; enter it under More options.", 14f, R.color.bad, top = 10)
        }
        val unconvertible = s.problems.size + s.bad
        if (unconvertible > 0) {
            text(c, "${fmt(unconvertible)} damaged or incomplete record(s) cannot be converted; they are listed in the report.",
                14f, R.color.bad, top = 6)
        }

        target(src?.format)

        val tree = savedTree()
        val usable = Session.treeUsable(this, tree)
        val f = card()
        text(f, "Save to", 13f, R.color.muted, bold = true)
        text(f, if (usable) Saf.OutputFolder(this, tree!!).name else "No folder chosen yet", 17f, bold = true, top = 2)
        text(f, "Pick a folder, or create one (for example a folder named SMS inside Download). The new backup file, a report and a list of every " +
            "message are saved there.", 14f, R.color.muted, top = 4)
        button(f, if (usable) "Change folder" else "Choose folder", primary = false, top = 12) {
            pendingSample = null
            pickOutput()
        }

        text(content, "Start with a small test file. Restore it on the new phone and check that a few conversations " +
            "look right, then convert everything.", 14f, R.color.muted, top = 20)
        button(content, "Make a test file (a few messages)", primary = true, top = 12) { startConvert(true) }
        val total = s.sms + s.mms - s.problems.size
        button(content, "Convert all ${fmt(total)} messages", primary = false, top = 10) { startConvert(false) }

        val more = button(content, if (Session.showOptions) "Hide options" else "More options", primary = false, flat = true, top = 14) {
            Session.showOptions = !Session.showOptions
            render()
        }
        more.gravity = Gravity.CENTER
        if (Session.showOptions) options(s.owner)
        button(content, "Choose a different backup", primary = false, flat = true, top = 4) { Session.reset() }
    }

    /** The new phone's format and what to keep. */
    private fun target(from: String?) {
        val t = card()
        text(t, "Make a backup for", 15f, bold = true)
        val to = RadioGroup(this)
        val sbr = radio(to, "SMS Backup & Restore: any Android phone, including the MindPhone")
        val fig = radio(to, "Fig or TAK (imported with SMS Import / Export)")
        val wonder = radio(to, "Wonder")
        t.addView(to, lp(top = 4))
        val hint = text(t, "", 13f, R.color.muted, top = 4)
        fun hintFor(target: String) {
            hint.text = when {
                target == "fig" && from == "sie" -> "This backup is already a Fig / TAK backup: it can be restored on a Fig or TAK " +
                    "as it is. Convert it only to leave things out."
                target == "wonder" -> "Wonder backups keep the main parts of each message (texts, dates, pictures, group members)."
                else -> ""
            }
            hint.visibility = if (hint.text.isEmpty()) View.GONE else View.VISIBLE
        }
        to.check(when (Session.options.to) {
            "fig" -> fig.id
            "wonder" -> wonder.id
            else -> sbr.id
        })
        hintFor(Session.options.to)
        to.setOnCheckedChangeListener { _, id ->
            val v = when (id) {
                fig.id -> "fig"
                wonder.id -> "wonder"
                else -> "sbr"
            }
            Session.options = Session.options.copy(to = v)
            hintFor(v)
        }

        text(t, "What to keep", 15f, bold = true, top = 18)
        val keep = RadioGroup(this)
        val all = radio(keep, "Everything")
        val sms = radio(keep, "Only text messages (SMS)")
        val mms = radio(keep, "Only picture and group messages (MMS)")
        t.addView(keep, lp(top = 4))
        keep.check(when (Session.options.keep) {
            "sms" -> sms.id
            "mms" -> mms.id
            else -> all.id
        })
        keep.setOnCheckedChangeListener { _, id ->
            Session.options = Session.options.copy(keep = when (id) {
                sms.id -> "sms"
                mms.id -> "mms"
                else -> "all"
            })
        }
        checkBox(t, "Leave out group chats", Session.options.noGroups) { Session.options = Session.options.copy(noGroups = it) }
        checkBox(t, "Leave out PDF files", Session.options.noPdf) { Session.options = Session.options.copy(noPdf = it) }
        text(t, "Leaving things out makes the new backup smaller; some phones' messaging apps cannot show PDF files.",
            13f, R.color.muted, top = 4)
    }

    private fun options(detected: List<String>) {
        val c = card()
        text(c, "Big backups", 15f, bold = true)
        text(c, "Save the backup as several files of at most this size. Restore them in order, part 1 first.",
            13f, R.color.muted, top = 2)
        var size: EditText? = null
        checkBox(c, "Save in parts", Session.splitOn) {
            Session.splitOn = it
            size?.isEnabled = it
            size?.alpha = if (it) 1f else 0.4f
        }
        size = edit(c, Session.splitText, "MB per part, e.g. 500", InputType.TYPE_CLASS_NUMBER) { Session.splitText = it.trim() }
        size.isEnabled = Session.splitOn
        size.alpha = if (Session.splitOn) 1f else 0.4f

        text(c, "Time zone", 15f, bold = true, top = 18)
        text(c, "Used only for the date text shown inside the backup file; message times are kept exactly.", 13f, R.color.muted, top = 2)
        val zones = ZoneId.getAvailableZoneIds().filter { '/' in it && !it.startsWith("Etc/") && !it.startsWith("SystemV/") }
            .sorted().toMutableList()
        val current = Session.options.tz ?: localTimeZone()
        if (current !in zones) zones.add(0, current)
        val spinner = Spinner(this)
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_item, zones).apply {
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item)
        }
        spinner.setSelection(zones.indexOf(current))
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val z = zones[position]
                Session.options = Session.options.copy(tz = if (z == localTimeZone()) null else z)
            }

            override fun onNothingSelected(parent: AdapterView<*>?) {}
        }
        c.addView(spinner, lp(top = 6))

        text(c, "Your phone number", 15f, bold = true, top = 18)
        text(c, "Only needed if it was not found or is wrong. Separate several numbers with commas.", 13f, R.color.muted, top = 2)
        val owner = edit(c, Session.options.owner ?: "", if (detected.isNotEmpty()) "Found: " + detected.joinToString(", ") else "e.g. +1 555 123 4567",
            InputType.TYPE_CLASS_PHONE) { Session.options = Session.options.copy(owner = it.trim().ifEmpty { null }) }
        owner.imeOptions = android.view.inputmethod.EditorInfo.IME_ACTION_DONE

        text(c, "SIM card", 15f, bold = true, top = 18)
        val sim = RadioGroup(this)
        val simUnknown = radio(sim, "Unknown: show on any SIM (recommended)")
        val simKeep = radio(sim, "Keep the old phone's SIM numbers")
        val simNumber = radio(sim, "Use this SIM number:")
        c.addView(sim, lp(top = 4))
        val number = edit(c, if (isInt(Session.options.subId)) Session.options.subId else "", "SIM number, e.g. 1",
            InputType.TYPE_CLASS_NUMBER) {
            if (simNumber.isChecked) Session.options = Session.options.copy(subId = it.trim().ifEmpty { "number" })
        }
        sim.check(when (Session.options.subId) {
            "unknown" -> simUnknown.id
            "keep" -> simKeep.id
            else -> simNumber.id
        })
        number.isEnabled = simNumber.isChecked
        number.alpha = if (number.isEnabled) 1f else 0.4f
        sim.setOnCheckedChangeListener { _, id ->
            number.isEnabled = id == simNumber.id
            number.alpha = if (number.isEnabled) 1f else 0.4f
            Session.options = Session.options.copy(subId = when (id) {
                simUnknown.id -> "unknown"
                simKeep.id -> "keep"
                else -> number.text.toString().trim().ifEmpty { "number" }
            })
        }

        text(c, "Characters a backup file cannot hold", 15f, bold = true, top = 18)
        text(c, "A few messages can contain invisible control characters that are not allowed in the file.", 13f, R.color.muted, top = 2)
        val nul = RadioGroup(this)
        val strip = radio(nul, "Remove them (recommended)")
        val replace = radio(nul, "Replace them with �")
        c.addView(nul, lp(top = 4))
        nul.check(if (Session.options.nul == "strip") strip.id else replace.id)
        nul.setOnCheckedChangeListener { _, id -> Session.options = Session.options.copy(nul = if (id == strip.id) "strip" else "replace") }
    }

    private fun done(s: Session.Done) {
        val many = s.files.size > 1
        val c = card(if (s.passed) R.color.ok_soft else R.color.bad_soft)
        if (s.passed) {
            text(c, "✓  Ready to restore", 20f, R.color.ok, bold = true)
            text(c, "The saved " + (if (many) "files were" else "file was") + " read back and checked against your backup: every " +
                "message and attachment matches.", top = 6)
        } else {
            text(c, "✗  Verification failed", 20f, R.color.bad, bold = true)
            text(c, "Do not restore " + (if (many) "these files" else "this file") + ". A file that failed is kept under a name " +
                "ending in .partial, and the report explains what did not match.", top = 6)
            for (e in s.errors.take(8)) text(c, "•  $e", 14f, R.color.bad, top = 4)
        }

        val f = card()
        text(f, (if (s.sample) "Test file" else "Backup") + " for " + TARGET_LABELS[s.to] + if (many) ", in ${s.files.size} parts" else "",
            13f, R.color.muted, bold = true)
        for (name in s.files) text(f, name, 17f, bold = true, top = 2)
        text(f, "in ${s.folder}", 14f, R.color.muted, top = 2)
        fact(f, fmt(s.sms + s.mms), "messages: ${fmt(s.sms)} SMS and ${fmt(s.mms)} MMS")
        fact(f, fmt(s.attachments), "attachments")
        s.conversations?.let { fact(f, fmt(it), "conversations after restoring") }
        val left = listOfNotNull(s.leftOut["mms"]?.takeIf { it > 0 }?.let { "${fmt(it)} MMS" },
            s.leftOut["sms"]?.takeIf { it > 0 }?.let { "${fmt(it)} SMS" },
            s.leftOut["groups"]?.takeIf { it > 0 }?.let { "${fmt(it)} group messages" },
            s.leftOut["pdf"]?.takeIf { it > 0 }?.let { "${fmt(it)} PDF files" })
        if (left.isNotEmpty()) text(f, "Left out as you chose: " + left.joinToString(", ") + ".", 14f, top = 8)
        text(f, "Also saved there: ${s.reportName} and a .manifest.csv list of every message" + (if (many) " for each part." else "."),
            13f, R.color.muted, top = 10)

        if (s.passed) {
            val n = card()
            text(n, "Next", 15f, bold = true)
            val name = if (many) "${s.files.first()} to ${s.files.last()}" else s.files.first()
            val steps = when (s.to) {
                "fig" -> "Copy $name to the Fig or TAK phone (don't unzip it). Open its message backup / restore screen " +
                    "(SMS Import / Export), choose Import, and pick the file."
                "wonder" -> "Copy $name to the Wonder phone (don't unzip it). Open its message backup screen, choose " +
                    "Restore, and pick the file."
                else -> "Open SMS Backup & Restore, tap Restore, choose the local backup, pick $name from ${s.folder}, and " +
                    "follow its steps."
            }
            text(n, steps, top = 4)
            if (many) text(n, "Restore part 1 first, then the other parts in order. Each one adds its messages; nothing is lost.",
                14f, top = 8)
            if (s.sample) {
                text(n, "This test file holds only a few messages. After restoring it and checking the conversations, " +
                    "come back and convert all messages.", 14f, R.color.muted, top = 8)
            }
            text(n, "Good to know", 15f, bold = true, top = 14)
            text(n, "•  A phone that already has messages keeps them. Restoring adds the old messages to the same chats " +
                "and skips any that are already there, so nothing shows up twice.", 14f, top = 4)
            text(n, "•  The MindPhone restores with SMS Backup & Restore. A Fig and a TAK use the same format: a backup " +
                "from one restores on the other as it is.", 14f, top = 4)
            text(n, "•  Keep your original backup until you have checked the restored messages.", 14f, top = 4)
        }

        if (s.sample && s.passed) button(content, "Convert all messages", primary = true, top = 20) { startConvert(false) }
        button(content, if (Session.showReport) "Hide the report" else "Show the report", primary = false, top = 10) {
            Session.showReport = !Session.showReport
            render()
        }
        if (Session.showReport) {
            // Scrolls sideways rather than wrapping, so the report's columns stay lined up.
            val r = card()
            val lines = s.report.lines()
            val shown = if (lines.size > 1500) lines.take(1500) + "… (the full report is in ${s.reportName})" else lines
            val wide = HorizontalScrollView(this)
            val inner = LinearLayout(this)
            wide.addView(inner)
            r.addView(wide, lp())
            text(inner, shown.joinToString("\n"), 11f).apply {
                typeface = Typeface.MONOSPACE
                setHorizontallyScrolling(true)
                layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT)
            }
        }
        button(content, "Back", primary = false, flat = true, top = 10) { Session.backToReady() }
    }

    private fun failed(s: Session.Failed) {
        val c = card(R.color.bad_soft)
        text(c, "Something went wrong", 18f, R.color.bad, bold = true)
        text(c, s.message, top = 6)
        button(content, "Back", primary = true, top = 16) { if (s.backToReady) Session.backToReady() else Session.reset() }
    }

    // ----------------------------------------------------------------------- actions

    private fun startConvert(sample: Boolean) {
        var o = Session.options
        if (o.subId != "unknown" && o.subId != "keep" && !isInt(o.subId)) {
            alert("Enter the SIM number under More options, or choose another SIM setting.")
            Session.showOptions = true
            render()
            return
        }
        if (Session.splitOn) {
            val mb = Session.splitText.toDoubleOrNull()
            if (mb == null || mb <= 0) {
                alert("Enter how many MB each part may have under More options, or turn off saving in parts.")
                Session.showOptions = true
                render()
                return
            }
            o = o.copy(splitMb = mb)
        } else {
            o = o.copy(splitMb = 0.0)
        }
        val tree = savedTree()
        if (!Session.treeUsable(this, tree)) {
            pendingSample = sample
            pickOutput()
            return
        }
        Session.convert(this, o.copy(sample = sample), tree!!)
    }

    private fun confirmCancel() {
        AlertDialog.Builder(this)
            .setMessage("Stop now? Nothing will be saved.")
            .setPositiveButton("Stop") { _, _ -> Session.cancel() }
            .setNegativeButton("Keep going", null)
            .show()
    }

    private fun alert(message: String) {
        AlertDialog.Builder(this).setMessage(message).setPositiveButton("OK", null).show()
    }

    private fun savedTree(): Uri? = prefs.getString("output", null)?.let(Uri::parse)

    private fun pickZip() = launch(Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
        addCategory(Intent.CATEGORY_OPENABLE)
        type = "*/*"
        putExtra(Intent.EXTRA_MIME_TYPES, arrayOf("application/zip", "application/x-zip-compressed", "application/x-zip",
            "application/octet-stream", "text/xml", "application/xml"))
    }, REQ_ZIP)

    private fun pickFolder() = launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE), REQ_FOLDER)

    private fun pickOutput() = launch(Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).addFlags(
        Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
            Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION), REQ_OUTPUT)

    private fun launch(intent: Intent, code: Int) {
        try {
            @Suppress("DEPRECATION")
            startActivityForResult(intent, code)
        } catch (e: ActivityNotFoundException) {
            alert("This phone has no file picker available.")
        }
    }

    @Deprecated("Deprecated in Java")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        val uri = data?.data
        if (resultCode != RESULT_OK || uri == null) {
            pendingSample = null
            return
        }
        when (requestCode) {
            REQ_ZIP -> Session.open(this, uri, folder = false)
            REQ_FOLDER -> Session.open(this, uri, folder = true)
            REQ_OUTPUT -> {
                val flags = Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_GRANT_WRITE_URI_PERMISSION
                try {
                    contentResolver.takePersistableUriPermission(uri, flags)
                } catch (e: SecurityException) {
                    alert("This folder cannot be used. Please choose another one.")
                    return
                }
                savedTree()?.takeIf { it != uri }?.let {
                    try {
                        contentResolver.releasePersistableUriPermission(it, flags)
                    } catch (e: SecurityException) {
                        // already released
                    }
                }
                prefs.edit().putString("output", uri.toString()).apply()
                val pending = pendingSample
                pendingSample = null
                if (pending != null) startConvert(pending)
            }
        }
    }

    // ----------------------------------------------------------------------- views

    private fun dp(v: Int) = (v * resources.displayMetrics.density).roundToInt()
    private fun color(id: Int) = getColor(id)

    private fun lp(top: Int = 0) = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
        .apply { topMargin = dp(top) }

    private fun rounded(fill: Int, stroke: Int? = null, radius: Int = 14) = GradientDrawable().apply {
        cornerRadius = dp(radius).toFloat()
        setColor(fill)
        if (stroke != null) setStroke(dp(1), stroke)
    }

    private fun card(fill: Int = R.color.surface): LinearLayout {
        val c = LinearLayout(this)
        c.orientation = LinearLayout.VERTICAL
        c.background = rounded(color(fill), color(R.color.border))
        c.setPadding(dp(16), dp(14), dp(16), dp(16))
        content.addView(c, lp(top = 16))
        return c
    }

    /** A text view that can never become a link or offer "Web search": no auto-links,
     *  no text classifier, not selectable. */
    private fun text(parent: LinearLayout, s: String, size: Float = 15f, colorId: Int = R.color.text,
                     bold: Boolean = false, top: Int = 0): TextView {
        val t = TextView(this)
        t.text = s
        t.textSize = size
        t.setTextColor(color(colorId))
        if (bold) t.setTypeface(t.typeface, Typeface.BOLD)
        t.autoLinkMask = 0
        t.linksClickable = false
        t.setTextIsSelectable(false)
        t.setTextClassifier(TextClassifier.NO_OP)
        t.setLineSpacing(0f, 1.15f)
        parent.addView(t, lp(top))
        return t
    }

    private fun fact(parent: LinearLayout, number: String, label: String) {
        val row = LinearLayout(this)
        row.orientation = LinearLayout.HORIZONTAL
        val n = TextView(this).apply {
            text = number
            textSize = 17f
            setTextColor(color(R.color.text))
            setTypeface(typeface, Typeface.BOLD)
            setTextClassifier(TextClassifier.NO_OP)
        }
        val l = TextView(this).apply {
            text = "  $label"
            textSize = 15f
            setTextColor(color(R.color.muted))
            setTextClassifier(TextClassifier.NO_OP)
        }
        row.addView(n)
        row.addView(l, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        parent.addView(row, lp(top = 8))
    }

    private fun button(parent: LinearLayout, label: String, primary: Boolean, flat: Boolean = false, top: Int = 0,
                       onClick: () -> Unit): Button {
        val b = Button(this)
        b.text = label
        b.isAllCaps = false
        b.textSize = 16f
        b.stateListAnimator = null
        b.minHeight = dp(52)
        b.setPadding(dp(16), dp(12), dp(16), dp(12))
        val fill = when {
            primary -> color(R.color.primary)
            flat -> color(R.color.bg)
            else -> color(R.color.surface)
        }
        b.setTextColor(if (primary) color(R.color.on_primary) else color(R.color.primary))
        if (!flat) b.setTypeface(b.typeface, Typeface.BOLD)
        val shape = rounded(fill, if (primary || flat) null else color(R.color.border), 12)
        b.background = RippleDrawable(ColorStateList.valueOf(color(R.color.primary_soft)), shape, rounded(0xFF000000.toInt(), null, 12))
        b.setOnClickListener { onClick() }
        parent.addView(b, lp(top))
        return b
    }

    private fun checkBox(parent: LinearLayout, label: String, checked: Boolean, onChange: (Boolean) -> Unit): CheckBox {
        val b = CheckBox(this)
        b.text = label
        b.textSize = 15f
        b.setTextColor(color(R.color.text))
        b.buttonTintList = ColorStateList.valueOf(color(R.color.primary))
        b.setTextClassifier(TextClassifier.NO_OP)
        b.isChecked = checked
        b.setOnCheckedChangeListener { _, v -> onChange(v) }
        parent.addView(b, lp(top = 2))
        return b
    }

    private fun radio(group: RadioGroup, label: String): RadioButton {
        val r = RadioButton(this)
        r.id = View.generateViewId()
        r.text = label
        r.textSize = 15f
        r.setTextColor(color(R.color.text))
        r.buttonTintList = ColorStateList.valueOf(color(R.color.primary))
        r.setTextClassifier(TextClassifier.NO_OP)
        group.addView(r)
        return r
    }

    /** An input box whose selection menu only offers cut, copy, paste and select all: the
     *  "Web search", "Share", "Translate" and other app actions are removed. */
    private fun edit(parent: LinearLayout, value: String, hint: String, type: Int, onChange: (String) -> Unit): EditText {
        val e = EditText(this)
        e.setText(value)
        e.hint = hint
        e.inputType = type
        e.isSingleLine = true
        e.setTextColor(color(R.color.text))
        e.setHintTextColor(color(R.color.muted))
        e.backgroundTintList = ColorStateList.valueOf(color(R.color.primary))
        e.setTextClassifier(TextClassifier.NO_OP)
        e.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO
        val allowed = setOf(android.R.id.cut, android.R.id.copy, android.R.id.paste, android.R.id.pasteAsPlainText,
            android.R.id.selectAll)
        val onlyEditing = object : ActionMode.Callback {
            private fun strip(menu: Menu) {
                for (i in menu.size() - 1 downTo 0) {
                    val id = menu.getItem(i).itemId
                    if (id !in allowed) menu.removeItem(id)
                }
            }

            override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
                strip(menu)
                return true
            }

            override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean {
                strip(menu)
                return true
            }

            override fun onActionItemClicked(mode: ActionMode, item: MenuItem) = false
            override fun onDestroyActionMode(mode: ActionMode) {}
        }
        e.customSelectionActionModeCallback = onlyEditing
        e.customInsertionActionModeCallback = onlyEditing
        e.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) {}
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) {}
            override fun afterTextChanged(s: Editable?) = onChange(s?.toString() ?: "")
        })
        parent.addView(e, lp(top = 4))
        return e
    }

    private fun day(ms: BigInteger?): String? = try {
        ms?.let { Instant.ofEpochMilli(it.toLong()).atZone(ZoneId.systemDefault()).format(DAY) }
    } catch (e: Exception) {
        null
    }

    companion object {
        private const val REQ_ZIP = 1
        private const val REQ_FOLDER = 2
        private const val REQ_OUTPUT = 3
        private val DAY = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US)
        private val FORMAT_NAMES = mapOf("sie" to "Fig / TAK", "sbr" to "SMS Backup & Restore", "wonder" to "Wonder",
            "pom" to "Pom", "buggy" to "Buggy Backup")
        private val TARGET_LABELS = mapOf("sbr" to "SMS Backup & Restore", "fig" to "Fig / TAK", "wonder" to "Wonder")
    }
}
