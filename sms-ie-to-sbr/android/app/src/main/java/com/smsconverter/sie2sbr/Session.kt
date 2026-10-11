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
import com.smsconverter.sie2sbr.core.ZipException
import com.smsconverter.sie2sbr.core.convert
import com.smsconverter.sie2sbr.core.fileStamp
import com.smsconverter.sie2sbr.core.load
import com.smsconverter.sie2sbr.core.manifest
import com.smsconverter.sie2sbr.core.report
import com.smsconverter.sie2sbr.core.summarize
import com.smsconverter.sie2sbr.core.verify
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
    class Done(
        val passed: Boolean, val sample: Boolean, val xmlName: String, val folder: String,
        val sms: Int, val mms: Int, val attachments: Int, val conversations: Int,
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
                val src = if (folder) Saf.openFolder(app, uri) else {
                    val (s, c) = Saf.openZip(app, uri) { done, total ->
                        progress("Copying the backup", if (total > 0) done.toFloat() / total else null, false) { mb(done) + " copied" }
                    }
                    closer = c
                    s
                }
                source = src
                val total = src.ndjsonSize
                val ld = load(src, { done ->
                    progress("Reading messages", if (total > 0) done.toFloat() / total else null) {
                        "${percent(done, total)} of messages.ndjson"
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

    /** Converts with the given options into the chosen folder, verifies the saved file, and
     *  writes the manifest and report next to it. */
    fun convert(ctx: Context, opts: Options, tree: Uri) {
        val app = ctx.applicationContext
        val src = source ?: return
        val ld = loaded ?: return
        val detected = plan ?: return
        cancelled = false
        showReport = false
        state = Busy("Preparing", "", null, true)
        listener?.invoke()
        thread(name = "convert") {
            val folder = Saf.OutputFolder(app, tree)
            var xml: Uri? = null
            try {
                val p = if (opts.owner.isNullOrBlank()) detected else Plan(ld.msgs, opts.owner)
                val now = ZonedDateTime.now()
                val base = (if (opts.sample) "sms-test-" else "sms-") + fileStamp(now)
                // The XML keeps a temporary name until it has passed verification, so a half-written
                // or failed file is never offered by SMS Backup & Restore as a backup.
                var doc = folder.create("$base.xml.partial", "application/octet-stream")
                xml = doc
                val renamable = folder.canRename(doc)
                if (!renamable) {
                    folder.delete(doc)
                    doc = folder.create("$base.xml", "text/xml")
                    xml = doc
                }
                val result = folder.writeSynced(doc) { out ->
                    convert(src, ld, p, opts, out, now, { i, n ->
                        progress("Writing messages", i.toFloat() / n) { "${fmt(i)} of ${fmt(n)}" }
                    }, { cancelled })
                }
                val verification = (app.contentResolver.openInputStream(doc) ?: throw IOException("Could not read the saved file back."))
                    .use { input ->
                        verify(input, result, { done ->
                            progress("Checking the saved file", done.toFloat() / result.bytes) {
                                mb(done) + " of " + mb(result.bytes)
                            }
                        }, { cancelled })
                    }
                set(Busy("Saving the report", "", null, false))
                if (renamable && verification.ok) doc = folder.rename(doc, "$base.xml")
                xml = null  // keep it from here on
                val xmlName = folder.nameOf(doc) ?: "$base.xml"
                folder.write("$base.manifest.csv", "application/octet-stream", manifest(result))
                val reportText = report(result, xmlName, verification)
                val reportName = folder.write("$base.report.txt", "text/plain", reportText)
                set(Done(verification.ok, opts.sample, xmlName, folder.name,
                    result.chosen.count { it.isSms }, result.chosen.count { it.isMms },
                    result.conv.attachments - result.conv.attachmentsMissing, verification.conversations,
                    verification.errors, reportName, reportText))
            } catch (e: CancellationException) {
                xml?.let { folder.delete(it) }
                set(Ready)
            } catch (e: OutOfMemoryError) {
                xml?.let { folder.delete(it) }
                set(Failed("This phone ran out of memory while converting.", true))
            } catch (e: Exception) {
                xml?.let { folder.delete(it) }
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
        is SourceException, is ZipException -> e.message ?: "This backup could not be read."
        is IOException -> "A file could not be read or written: " + (e.message ?: e.javaClass.simpleName) +
            ". Check that there is enough free space and try again."
        else -> "Something went wrong: " + (e.message ?: e.javaClass.simpleName)
    }

    fun fmt(n: Number): String = String.format(Locale.US, "%,d", n)
    private fun percent(done: Long, total: Long) = if (total > 0) "${(100 * done / total).coerceAtMost(100)}%" else mb(done)
    private fun mb(n: Long) = String.format(Locale.US, "%.1f MB", n / 1048576.0)
}
