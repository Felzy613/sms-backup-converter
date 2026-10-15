package com.smsconverter.sie2sbr

import android.content.Context
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.DocumentsContract
import com.smsconverter.sie2sbr.core.Loaded
import com.smsconverter.sie2sbr.core.Options
import com.smsconverter.sie2sbr.core.Plan
import com.smsconverter.sie2sbr.core.Source
import com.smsconverter.sie2sbr.core.SourceException
import com.smsconverter.sie2sbr.core.Summary
import com.smsconverter.sie2sbr.core.Verification
import com.smsconverter.sie2sbr.core.WrittenFile
import com.smsconverter.sie2sbr.core.ZipException
import com.smsconverter.sie2sbr.core.fileStamp
import com.smsconverter.sie2sbr.core.load
import com.smsconverter.sie2sbr.core.manifest
import com.smsconverter.sie2sbr.core.prepare
import com.smsconverter.sie2sbr.core.report
import com.smsconverter.sie2sbr.core.summarize
import com.smsconverter.sie2sbr.core.verify
import com.smsconverter.sie2sbr.core.verifyZip
import com.smsconverter.sie2sbr.core.writePart
import java.io.Closeable
import java.io.File
import java.io.IOException
import java.time.ZonedDateTime
import java.util.Locale
import java.util.concurrent.CancellationException
import kotlin.concurrent.thread

/** The app's state, kept for the life of the process so a screen rotation or a trip to the
 *  file picker never loses work. All heavy work runs on one background thread. */
object Session {
    sealed class State
    object Start : State()
    class Busy(val title: String, val detail: String, val fraction: Float?, val cancellable: Boolean) : State()
    object Ready : State()
    /** files: the names of the saved backup files (several when split into parts). */
    class Done(
        val passed: Boolean, val sample: Boolean, val to: String, val files: List<String>, val folder: String,
        val sms: Int, val mms: Int, val attachments: Int, val conversations: Int?, val leftOut: Map<String, Int>,
        val errors: List<String>, val reportName: String, val report: String,
    ) : State()
    class Failed(val message: String, val backToReady: Boolean) : State()

    var state: State = Start
        private set
    var listener: (() -> Unit)? = null

    var source: Source? = null
        private set
    private var closer: Closeable? = null
    private var loaded: Loaded? = null
    var plan: Plan? = null
        private set
    var summary: Summary? = null
        private set
    /** The options as last chosen on the screen (owner and SIM number as typed). */
    var options = Options()
    var showOptions = false
    /** "Save in parts" and the size typed for it (kept as typed until converting). */
    var splitOn = false
    var splitText = "500"
    var showReport = false

    private val main = Handler(Looper.getMainLooper())
    @Volatile private var cancelled = false
    private var lastPost = 0L

    private fun set(s: State) {
        main.post {
            state = s
            listener?.invoke()
        }
    }

    /** Posts progress at most ~8 times a second. */
    private fun progress(title: String, fraction: Float?, cancellable: Boolean = true, detail: () -> String) {
        val now = SystemClock.uptimeMillis()
        if (now - lastPost < 120) return
        lastPost = now
        set(Busy(title, detail(), fraction, cancellable))
    }

    val running get() = state is Busy

    fun cancel() {
        cancelled = true
    }

    /** Back to the first screen, forgetting the loaded export. */
    fun reset() {
        cancelled = true
        closeSource()
        summary = null
        showReport = false
        state = Start
        listener?.invoke()
    }

    private fun closeSource() {
        try {
            closer?.close()
        } catch (e: Exception) {
            // nothing to do
        }
        closer = null
        source = null
        loaded = null
        plan = null
    }

    fun backToReady() {
        showReport = false
        state = if (summary != null) Ready else Start
        listener?.invoke()
    }

    fun open(ctx: Context, uri: Uri, folder: Boolean) {
        val app = ctx.applicationContext
        closeSource()
        cancelled = false
        state = Busy("Opening the backup", "", null, false)
        listener?.invoke()
        thread(name = "open") {
            try {
                File(app.cacheDir, "source.zip").delete()
                app.cacheDir.listFiles { f -> f.name.startsWith("sms-convert-") }?.forEach { it.deleteRecursively() }
                val src = if (folder) Saf.openFolder(app, uri) else {
                    val (s, c) = Saf.openFile(app, uri) { done, total ->
                        progress("Copying the backup", if (total > 0) done.toFloat() / total else null, false) { mb(done) + " copied" }
                    }
                    closer = c
                    s
                }
                source = src
                val total = src.loadSize
                val ld = load(src, { done ->
                    progress("Reading messages", if (total > 0) done.toFloat() / total else null) {
                        if (total > 0) percent(done, total) + " read" else mb(done) + " read"
                    }
                }, { cancelled })
                set(Busy("Checking the messages", "${ld.msgs.size} messages read", null, false))
                val p = Plan(ld.msgs, null)
                val s = summarize(src, ld, p)
                loaded = ld
                plan = p
                summary = s
                set(Ready)
            } catch (e: CancellationException) {
                main.post { reset() }
            } catch (e: OutOfMemoryError) {
                main.post { closeSource() }
                set(Failed("This backup is too large for this phone's memory.", false))
            } catch (e: Exception) {
                main.post { closeSource() }
                set(Failed(explain(e), false))
            }
        }
    }

    /** The file names SMS Backup & Restore, SMS Import / Export and Wonder give their backups. */
    private fun fileName(to: String, sample: Boolean, now: ZonedDateTime): String {
        val ymd = "%04d-%02d-%02d".format(Locale.ROOT, now.year, now.monthValue, now.dayOfMonth)
        return when (to) {
            "fig" -> (if (sample) "messages-test-" else "messages-") + ymd + ".zip"
            "wonder" -> (if (sample) "Messages_Backup_test_" else "Messages_Backup_") + ymd + ".zip"
            else -> (if (sample) "sms-test-" else "sms-") + fileStamp(now) + ".xml"
        }
    }

    /** Converts with the given options into the chosen folder: each output file (several when
     *  split into parts) is written under a temporary name, synced to storage, checked (an SMS
     *  Backup & Restore file is re-read with a strict XML parser, a ZIP is re-read entry by
     *  entry), and only then given its real name. The manifests and report go next to them. */
    fun convert(ctx: Context, opts: Options, tree: Uri) {
        val app = ctx.applicationContext
        val src = source ?: return
        val ld = loaded ?: return
        cancelled = false
        showReport = false
        state = Busy("Preparing", "", null, true)
        listener?.invoke()
        thread(name = "convert") {
            val folder = Saf.OutputFolder(app, tree)
            var current: Uri? = null
            try {
                val now = ZonedDateTime.now()
                val job = prepare(src, ld, opts, now)
                if (job.chosen.isEmpty()) throw IllegalStateException("No message is left with these \"what to keep\" choices.")
                val name = fileName(opts.to, opts.sample, now)
                val ext = name.substring(name.lastIndexOf('.'))
                val stem = name.dropLast(ext.length)
                val n = job.parts.size
                val written = ArrayList<WrittenFile>()
                val names = ArrayList<String>()
                for (k in 0 until n) {
                    val target = if (n == 1) name else "$stem-part${k + 1}$ext"
                    val label = if (n == 1) "" else "Part ${k + 1} of $n: "
                    // A temporary name until the file has passed its check, so a half-written or
                    // failed file is never offered as a backup.
                    var doc = folder.create("$target.partial", "application/octet-stream")
                    current = doc
                    val renamable = folder.canRename(doc)
                    if (!renamable) {
                        folder.delete(doc)
                        doc = folder.create(target, if (opts.to == "sbr") "text/xml" else "application/zip")
                        current = doc
                    }
                    val part = folder.writeSynced(doc) { out ->
                        writePart(job, k, out, { i, total ->
                            progress(label + if (opts.to == "sbr") "Writing messages" else "Adding attachments",
                                (k + i.toFloat() / total) / n) { "${fmt(i)} of ${fmt(total)}" }
                        }, { cancelled })
                    }
                    val verification: Verification = if (opts.to == "sbr") {
                        (app.contentResolver.openInputStream(doc) ?: throw IOException("Could not read the saved file back.")).use { input ->
                            verify(input, job, part.msgs, { done ->
                                progress(label + "Checking the saved file", (k + done.toFloat() / part.bytes) / n) {
                                    mb(done) + " of " + mb(part.bytes)
                                }
                            }, { cancelled })
                        }
                    } else {
                        set(Busy(label + "Checking the saved file", "Reading it back", null, false))
                        folder.randomInput(doc).use { verifyZip(it, job, part) }
                    }
                    if (renamable && verification.ok) doc = folder.rename(doc, target)
                    current = null  // keep it from here on
                    val savedName = folder.nameOf(doc) ?: target
                    names.add(savedName)
                    folder.write(savedName.substringBeforeLast('.') + ".manifest.csv", "application/octet-stream", manifest(job, part.msgs))
                    written.add(WrittenFile(savedName, part.bytes, verification))
                }
                set(Busy("Saving the report", "", null, false))
                val reportText = report(job, written)
                val reportName = folder.write("$stem.report.txt", "text/plain", reportText)
                val conv = job.conv
                set(Done(written.all { it.verification?.ok == true }, opts.sample, opts.to, names, folder.name,
                    job.chosen.count { it.isSms }, job.chosen.count { it.isMms }, conv.attachments - conv.attachmentsMissing,
                    if (opts.to == "sbr" && n == 1) written[0].verification?.conversations else null, job.leftOut,
                    written.flatMap { it.verification?.errors ?: emptyList() }, reportName, reportText))
            } catch (e: CancellationException) {
                current?.let { folder.delete(it) }
                set(Ready)
            } catch (e: OutOfMemoryError) {
                current?.let { folder.delete(it) }
                set(Failed("This phone ran out of memory while converting.", true))
            } catch (e: Exception) {
                current?.let { folder.delete(it) }
                set(Failed(explain(e), true))
            }
        }
    }

    fun treeUsable(ctx: Context, tree: Uri?): Boolean =
        tree != null && try {
            DocumentsContract.getTreeDocumentId(tree)
            Saf.OutputFolder(ctx, tree).usable()
        } catch (e: Exception) {
            false
        }

    private fun explain(e: Exception): String = when (e) {
        is SourceException, is ZipException, is IllegalStateException -> e.message ?: "This backup could not be read."
        is IOException -> "A file could not be read or written: " + (e.message ?: e.javaClass.simpleName) +
            ". Check that there is enough free space and try again."
        else -> "Something went wrong: " + (e.message ?: e.javaClass.simpleName)
    }

    fun fmt(n: Number): String = String.format(Locale.US, "%,d", n)
    private fun percent(done: Long, total: Long) = if (total > 0) "${(100 * done / total).coerceAtMost(100)}%" else mb(done)
    private fun mb(n: Long) = String.format(Locale.US, "%.1f MB", n / 1048576.0)
}
