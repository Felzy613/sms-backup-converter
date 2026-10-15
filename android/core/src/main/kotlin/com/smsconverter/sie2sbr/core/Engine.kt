/* Message backup converter: the conversion engine.
 *
 * Reads Fig / TAK (SMS Import / Export), SMS Backup & Restore, Wonder, Pom and Buggy
 * Backup backups (Formats.kt) and writes SMS Backup & Restore XML, Fig / TAK ZIPs or
 * Wonder ZIPs (Output.kt). A port of assets/converter.js (itself a line-for-line port of
 * cli/sie_to_sbr.py): the same decisions and byte-identical files. Pure JVM code with no
 * Android dependency, so it runs unchanged in the app and on a desktop (see Cli.kt). It
 * never uses the network. */
package com.smsconverter.sie2sbr.core

import java.io.BufferedWriter
import java.io.ByteArrayOutputStream
import java.io.FilterOutputStream
import java.io.InputStream
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.security.MessageDigest
import java.time.Instant
import java.time.ZoneId
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.util.Base64
import java.util.Locale
import java.util.UUID
import java.util.concurrent.CancellationException

const val VERSION = "1.0.0"
const val APP = "sms-ie-to-sbr"
const val INSERT_TOKEN = "insert-address-token"  // Android's placeholder for the phone's own number
const val UNKNOWN_SUB_ID = "-1"                  // SubscriptionManager.INVALID_SUBSCRIPTION_ID

// Keys added by SMS Import / Export (v2 prefixes them with "__", v1 did not).
internal val K_PARTS = listOf("__parts", "parts")
internal val K_SENDER = listOf("__sender_address", "sender_address")
internal val K_RECIPS = listOf("__recipient_addresses", "recipient_addresses")
internal val K_NAME = listOf("__display_name", "display_name")

// Attributes in the order SMS Backup & Restore writes them; see cli/sie_to_sbr.py.
internal val SMS_ORDER = listOf("protocol", "address", "date", "type", "subject", "body", "toa", "sc_toa",
    "service_center", "read", "status", "locked", "date_sent", "sub_id", "readable_date", "contact_name")
internal val SMS_OMIT = setOf("protocol", "locked", "date_sent")
internal val MMS_ORDER = listOf("date", "rr", "sub", "ct_t", "read_status", "seen", "msg_box", "address",
    "sub_cs", "resp_st", "retr_st", "d_tm", "text_only", "exp", "locked", "m_id", "st",
    "retr_txt_cs", "retr_txt", "date_sent", "read", "m_size", "rpt_a", "ct_cls", "pri", "sub_id",
    "tr_id", "resp_txt", "ct_l", "m_cls", "d_rpt", "v", "m_type", "readable_date", "contact_name")
internal val MMS_OMIT = setOf("text_only")
internal val COMPUTED = setOf("date", "address", "sub_id", "readable_date", "contact_name")
internal val MMS_COPIED = MMS_ORDER.filter { it !in COMPUTED }
internal val PART_ATTRS = listOf("seq", "ct", "name", "chset", "cd", "fn", "cid", "cl", "ctt_s", "ctt_t", "text")
internal val ADDR_ATTRS = listOf("address", "type", "charset")
internal val SMS_TYPES = mapOf("1" to "received", "2" to "sent", "3" to "draft", "4" to "outbox", "5" to "failed", "6" to "queued")
internal val MMS_BOXES = mapOf("1" to "received", "2" to "sent", "3" to "draft", "4" to "outbox")

val TARGETS = listOf("sbr", "fig", "wonder")
val TARGET_NAMES = mapOf("sbr" to "SMS Backup & Restore XML", "fig" to "Fig / TAK (SMS Import / Export ZIP)",
    "wonder" to "Wonder ZIP")
internal const val APP_PARTS = "/data/user_de/0/com.android.providers.telephony/app_parts/"  // where Android keeps MMS files
// Buggy Backup stores each SMS as JSON with one-letter keys; these are the Android columns.
internal val BUGGY_KEYS = listOf("q" to "address", "r" to "body", "m" to "date", "n" to "date_sent", "h" to "type",
    "b" to "read", "k" to "protocol", "g" to "status", "d" to "locked", "l" to "sub_id", "o" to "creator", "e" to "seen")
// File name extensions for attachments written to a Wonder ZIP.
internal val EXTENSIONS = mapOf("image/jpeg" to "jpg", "image/jpg" to "jpg", "image/png" to "png", "image/gif" to "gif",
    "image/bmp" to "bmp", "image/webp" to "webp", "audio/amr" to "amr", "audio/mpeg" to "mp3", "audio/mp4" to "m4a",
    "video/mp4" to "mp4", "video/3gpp" to "3gp", "application/pdf" to "pdf", "text/x-vcard" to "vcf", "text/vcard" to "vcf")
val DESCRIBE = mapOf(
    "sie" to "Fig / TAK: SMS Import / Export (com.github.tmo1.sms_ie) export: messages.ndjson + data/",
    "sbr" to "SMS Backup & Restore XML backup (attachments inside, as base64)",
    "wonder" to "Wonder ZIP backup: an XML file + mms_attachments/",
    "pom" to "Pom ZIP backup: sms.xml + mms.xml (attachments inside, as base64)",
    "buggy" to "Buggy Backup ZIP: conversations/conv_N (SMS only)",
)
private val MONTHS = listOf("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

/** to: the format written, "sbr" | "fig" | "wonder". sample: write a small test set.
 *  keep: "all" | "sms" | "mms". noGroups: leave out group MMS. noPdf: leave out PDF
 *  attachments. splitMb: write outputs bigger than this as parts (0: one file).
 *  subId: "unknown" | "keep" | a number. tz: IANA zone for readable_date, null for this
 *  device's. nul: "strip" | "replace". owner: own number(s). */
data class Options(
    val to: String = "sbr",
    val sample: Boolean = false,
    val keep: String = "all",
    val noGroups: Boolean = false,
    val noPdf: Boolean = false,
    val splitMb: Double = 0.0,
    val subId: String = "unknown",
    val tz: String? = null,
    val nul: String = "strip",
    val owner: String? = null,
)

// ------------------------------------------------------------------------- helpers

fun pick(o: Any?, keys: List<String>): Any? {
    if (o !is JObj) return null
    for (k in keys) {
        val v = o[k]
        if (v != null && v !== JNull) return v
    }
    return null
}

/** A column value as a string, or null when the source has no value. */
fun sval(o: Any?, key: String): String? {
    if (o !is JObj) return null
    return when (val v = o[key]) {
        null, JNull, is JObj, is List<*> -> null
        is Boolean -> if (v) "1" else "0"
        is String -> v
        else -> v.toString()
    }
}

private val INT_RE = Regex("-?[0-9]+")
fun isInt(s: String?) = s != null && INT_RE.matches(s)

fun partFile(p: JObj): String? {
    val d = sval(p, "_data")
    if (d.isNullOrEmpty()) return null
    return d.replace('\\', '/').substringAfterLast('/').ifEmpty { null }
}

fun digits(s: String?): String = (s ?: "").filter { it in '0'..'9' }

/** Whitespace as JavaScript's trim() and \s see it. */
private fun isSpace(c: Char) = c == ' ' || c in '\t'..'\r' || c == ' ' || c == ' ' ||
    c in ' '..' ' || c == ' ' || c == ' ' || c == ' ' || c == ' ' ||
    c == '　' || c == '﻿'

private fun tokens(a: String): List<String> {
    val out = ArrayList<String>()
    var start = -1
    for (i in a.indices) {
        if (isSpace(a[i])) {
            if (start >= 0) out.add(a.substring(start, i))
            start = -1
        } else if (start < 0) start = i
    }
    if (start >= 0) out.add(a.substring(start))
    return out
}

/** Loose identity of an address, close to Android's PHONE_NUMBERS_EQUAL matching. */
fun addrKey(a0: String?): String {
    val a = (a0 ?: "").trim(::isSpace)
    val tokens = tokens(a)
    if (tokens.size > 1 && tokens.all { digits(it).length >= 7 }) {
        return "multi:" + tokens.map(::addrKey).toSet().sorted().joinToString(",")
    }
    val d = digits(a)
    if (d.length >= 7 && a.none { it in 'A'..'Z' || it in 'a'..'z' || it == '@' }) return d.takeLast(10)
    return a.lowercase(Locale.ROOT)
}

fun mask(a: String): String {
    val d = digits(a)
    if (a.startsWith("multi:")) return "[" + a.split(',').size + " numbers]"
    return if (d.length >= 7) "…" + d.takeLast(4) else a
}

fun esc(s: String): String {
    var i = 0
    while (i < s.length && s[i] !in "&<>\"\n\r\t") i++
    if (i == s.length) return s
    val b = StringBuilder(s.length + 16).append(s, 0, i)
    while (i < s.length) {
        when (val c = s[i++]) {
            '&' -> b.append("&amp;")
            '<' -> b.append("&lt;")
            '>' -> b.append("&gt;")
            '"' -> b.append("&quot;")
            '\n' -> b.append("&#10;")
            '\r' -> b.append("&#13;")
            '\t' -> b.append("&#9;")
            else -> b.append(c)
        }
    }
    return b.toString()
}

private val THOUSAND = BigInteger.valueOf(1000)
private val MAX_SECS = BigInteger.valueOf(8_640_000_000_000L)  // the range of a JavaScript Date

internal fun floorDiv1000(ms: BigInteger): BigInteger {
    val qr = ms.divideAndRemainder(THOUSAND)
    return if (qr[1].signum() < 0) qr[0] - BigInteger.ONE else qr[0]
}

private fun pad(n: Int, w: Int = 2) = n.toString().padStart(w, '0')

private val ZONES = HashMap<String, ZoneId>()
private fun zone(tz: String?): ZoneId =
    if (tz == null) ZoneId.systemDefault() else synchronized(ZONES) { ZONES.getOrPut(tz) { ZoneId.of(tz) } }

/** The date the way SMS Backup & Restore shows it, e.g. 'Sep 30, 2010 8:34:28 AM'. */
fun readable(ms: BigInteger?, tz: String?): String? {
    if (ms == null) return null
    val secs = floorDiv1000(ms)
    if (secs.abs() > MAX_SECS) return null
    val t = Instant.ofEpochSecond(secs.toLong()).atZone(zone(tz))
    if (t.year < 1 || t.year > 9999) return null
    val hour = t.hour
    return MONTHS[t.monthValue - 1] + " " + t.dayOfMonth + ", " + t.year + " " + (if (hour % 12 == 0) 12 else hour % 12) +
        ":" + pad(t.minute) + ":" + pad(t.second) + " " + (if (hour < 12) "AM" else "PM")
}

fun utc(ms: BigInteger, withSeconds: Boolean = true): String {
    val secs = floorDiv1000(ms)
    if (secs.abs() > MAX_SECS) return ""
    val d = Instant.ofEpochSecond(secs.toLong()).atOffset(ZoneOffset.UTC)
    if (d.year < 1 || d.year > 9999) return ""
    val day = pad(d.year, 4) + "-" + pad(d.monthValue) + "-" + pad(d.dayOfMonth)
    val time = pad(d.hour) + ":" + pad(d.minute)
    return if (withSeconds) "$day $time:" + pad(d.second) else "$day $time UTC"
}

/** An error message for an unknown time zone name, or null. */
fun checkTimeZone(tz: String?): String? {
    if (tz == null) return null
    return try {
        zone(tz)
        null
    } catch (e: Exception) {
        "Unknown time zone \"$tz\" - use a name like America/New_York or Europe/London."
    }
}

fun localTimeZone(): String = ZoneId.systemDefault().id

fun subIdFor(o: JObj, policy: String): String? = when (policy) {
    "keep" -> sval(o, "sub_id")
    "unknown" -> UNKNOWN_SUB_ID
    else -> policy
}

/** Characters XML 1.0 cannot contain at all, not even as &#..; references. */
private fun illegal(cp: Int) = cp <= 0x08 || cp == 0x0B || cp == 0x0C || cp in 0x0E..0x1F ||
    cp == 0xFFFE || cp == 0xFFFF || cp in 0xD800..0xDFFF

/** The illegal code points of s, in order (an unpaired surrogate counts as one). */
private fun illegalIn(s: String): List<Int> {
    var out: MutableList<Int>? = null
    var i = 0
    while (i < s.length) {
        val cp = s.codePointAt(i)
        if (illegal(cp)) (out ?: ArrayList<Int>().also { out = it }).add(cp)
        i += Character.charCount(cp)
    }
    return out ?: emptyList()
}

fun isPdf(p: JObj) = (sval(p, "ct") ?: "").split(';')[0].trim().lowercase(Locale.ROOT) == "application/pdf"

/** The MMS parts that are written: all of them, or all but PDF files with noPdf. */
fun writtenParts(m: Msg, options: Options): List<JObj> = if (options.noPdf) m.parts.filter { !isPdf(it) } else m.parts

/** The UTF-8 size of a text; an unpaired surrogate counts as 3 bytes. */
fun u8len(s: String?): Int {
    if (s == null) return 0
    var n = 0
    var i = 0
    while (i < s.length) {
        val c = s[i]
        n += when {
            c.code < 0x80 -> 1
            c.code < 0x800 -> 2
            Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> { i++; 4 }
            else -> 3
        }
        i++
    }
    return n
}

fun clean(s: String?, mode: String): String? {
    if (s.isNullOrEmpty() || illegalIn(s).isEmpty()) return s
    val b = StringBuilder(s.length)
    var i = 0
    while (i < s.length) {
        val cp = s.codePointAt(i)
        if (!illegal(cp)) b.appendCodePoint(cp) else if (mode != "strip") b.append('�')
        i += Character.charCount(cp)
    }
    return b.toString()
}

/** Local time as YYYYMMDDHHMMSS, the stamp SMS Backup & Restore puts in file names. */
fun fileStamp(d: ZonedDateTime) = pad(d.year, 4) + pad(d.monthValue) + pad(d.dayOfMonth) +
    pad(d.hour) + pad(d.minute) + pad(d.second)

fun localStamp(d: ZonedDateTime): String {
    val off = d.offset.totalSeconds / 60
    return pad(d.year, 4) + "-" + pad(d.monthValue) + "-" + pad(d.dayOfMonth) + " " +
        pad(d.hour) + ":" + pad(d.minute) + ":" + pad(d.second) + " " +
        (if (off < 0) "-" else "+") + pad(Math.abs(off) / 60) + pad(Math.abs(off) % 60)
}

private fun digest(bytes: ByteArray): String {
    val h = MessageDigest.getInstance("SHA-256").digest(bytes)
    return h.joinToString("") { "%02x".format(it) } + ":" + bytes.size
}

internal fun digestOf(bytes: ByteArray) = digest(bytes)

// ------------------------------------------------------------------------- source

/** Read-only access to a backup: its records (load) and attachment files (by name). */
interface Source : java.io.Closeable {
    val kind: String     // "zip", "folder" or "file"
    val label: String
    /** The attachment files there are (complete after load()). */
    val names: Set<String>
    /** "sie" (Fig / TAK: SMS Import / Export), "sbr", "wonder", "pom" or "buggy". */
    val format: String
    val describe: String get() = DESCRIBE[format]!!
    /** What a record number counts: a line of messages.ndjson, or a record of other formats. */
    val unit: String get() = if (format == "sie") "line" else "record"
    /** About how many bytes load() reads (for progress), or -1 if unknown. */
    val loadSize: Long
    fun load(onBytes: ((Long) -> Unit)? = null, cancelled: () -> Boolean = { false }): Loaded
    fun readPart(name: String): ByteArray
    fun partSize(name: String): Long
    override fun close() {}
}

class SourceException(message: String) : Exception(message)

/** An SMS Import / Export export (Fig, TAK) in a ZIP archive. */
class ZipSource(private val zip: ZipArchive, override val label: String) : Source {
    override val kind = "zip"
    override val format = "sie"
    private val ndjson: String
    private val members = HashMap<String, String>()
    override val names: Set<String>

    init {
        val found = zip.names.filter { it.substringAfterLast('/') == "messages.ndjson" }
        if (found.isEmpty()) {
            throw SourceException("There is no messages.ndjson in this ZIP file. Choose the messages-YYYY-MM-DD.zip " +
                "that SMS Import / Export created.")
        }
        ndjson = found.reduce { a, b -> if (b.length < a.length) b else a }
        val prefix = ndjson.dropLast("messages.ndjson".length) + "data/"
        val keys = LinkedHashSet<String>()
        for (n in zip.names) if (n.startsWith(prefix) && !n.endsWith("/")) {
            members[n.substring(prefix.length)] = n
            keys.add(n.substring(prefix.length))
        }
        names = keys
    }

    override val loadSize get() = zip.entries[ndjson]!!.usize
    fun openNdjson() = zip.open(ndjson)
    override fun load(onBytes: ((Long) -> Unit)?, cancelled: () -> Boolean) = openNdjson().use { parseNdjson(it, onBytes, cancelled) }
    override fun readPart(name: String) = zip.read(members[name]!!)
    override fun partSize(name: String) = zip.entries[members[name]!!]!!.usize
}

/** One file of an extracted export: its path relative to the chosen folder. */
class SourceFile(val path: String, val size: Long, val open: () -> InputStream)

/** An extracted SMS Import / Export export (Fig, TAK). */
class FolderSource(files: List<SourceFile>, override val label: String) : Source {
    override val kind = "folder"
    override val format = "sie"
    private val nd: SourceFile
    private val partsByName = LinkedHashMap<String, SourceFile>()
    override val names: Set<String> get() = partsByName.keys

    init {
        val found = files.filter { it.path.substringAfterLast('/') == "messages.ndjson" }
        if (found.isEmpty()) {
            throw SourceException("There is no messages.ndjson in this folder. Choose the folder that contains " +
                "messages.ndjson and the data folder.")
        }
        nd = found.reduce { a, b -> if (b.path.length < a.path.length) b else a }
        val prefix = nd.path.dropLast("messages.ndjson".length) + "data/"
        for (f in files) {
            val rest = if (f.path.startsWith(prefix)) f.path.substring(prefix.length) else ""
            if (rest.isNotEmpty() && '/' !in rest) partsByName[rest] = f
        }
    }

    override val loadSize get() = nd.size
    fun openNdjson() = nd.open()
    override fun load(onBytes: ((Long) -> Unit)?, cancelled: () -> Boolean) = openNdjson().use { parseNdjson(it, onBytes, cancelled) }
    override fun readPart(name: String) = partsByName[name]!!.open().use { it.readBytes() }
    override fun partSize(name: String) = partsByName[name]!!.size
}

/** One source record: its line number in messages.ndjson, "sms" or "mms", the JSON object. */
class Msg(val line: Int, val kind: String, val o: JObj) {
    val isSms get() = kind == "sms"
    val isMms get() = kind == "mms"

    /** The date in milliseconds (MMS dates are stored in seconds), or null. */
    val dateMs: BigInteger? by lazy(LazyThreadSafetyMode.NONE) {
        val d = sval(o, "date")
        if (!isInt(d)) null else {
            val v = BigInteger(d)
            if (isMms && v < BigInteger.valueOf(100_000_000_000L)) v * THOUSAND else v
        }
    }

    val direction: String
        get() = if (isSms) {
            val t = sval(o, "type")
            SMS_TYPES[t] ?: ("type " + (t ?: "None"))
        } else {
            val b = sval(o, "msg_box")
            MMS_BOXES[b] ?: ("msg_box " + (b ?: "None"))
        }

    val parts: List<JObj> by lazy(LazyThreadSafetyMode.NONE) {
        (pick(o, K_PARTS) as? List<*>)?.filterIsInstance<JObj>() ?: emptyList()
    }

    /** The MMS's address rows (From/To/Cc/Bcc) in their original order in the phone's table. */
    val addrRows: List<JObj> by lazy(LazyThreadSafetyMode.NONE) {
        val rows = ArrayList<JObj>()
        val s = pick(o, K_SENDER)
        if (s is JObj) rows.add(s)
        val r = pick(o, K_RECIPS)
        if (r is List<*>) rows.addAll(r.filterIsInstance<JObj>())
        if (rows.isNotEmpty() && rows.all { isInt(sval(it, "_id")) }) rows.sortBy { BigInteger(sval(it, "_id")) }
        rows
    }

    val dateOrZero: BigInteger get() = dateMs ?: BigInteger.ZERO
}

class Loaded(val msgs: List<Msg>, val bad: List<Pair<Int, String>>, val blank: Int)

private fun isBlank(b: Byte) = b == 0x20.toByte() || b == 0x09.toByte() || b == 0x0A.toByte() ||
    b == 0x0D.toByte() || b == 0x0B.toByte() || b == 0x0C.toByte()

/** Reads messages.ndjson. onBytes(n) reports progress; cancelled() stops it. */
fun parseNdjson(input: InputStream, onBytes: ((Long) -> Unit)? = null, cancelled: () -> Boolean = { false }): Loaded {
    val msgs = ArrayList<Msg>()
    val bad = ArrayList<Pair<Int, String>>()
    var blank = 0
    var line = 0
    val parser = JsonParser()
    val decoder = Charsets.UTF_8.newDecoder()
        .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
    val pending = ByteArrayOutputStream(1 shl 16)
    val buf = ByteArray(1 shl 16)
    var total = 0L

    fun handle(raw: ByteArray, len: Int) {
        line += 1
        if ((0 until len).all { isBlank(raw[it]) }) {
            blank += 1
            return
        }
        val o = try {
            parser.parse(decoder.decode(ByteBuffer.wrap(raw, 0, len)).toString())
        } catch (e: CharacterCodingException) {
            bad.add(line to "unreadable line: the text is not valid UTF-8")
            return
        } catch (e: JsonException) {
            bad.add(line to "unreadable line: " + e.message)
            return
        }
        val kind = classify(o)
        if (kind != null) msgs.add(Msg(line, kind, o as JObj))
        else bad.add(line to if (o is JObj) "neither an SMS nor an MMS record" else "line is not a JSON object")
    }

    while (true) {
        if (cancelled()) throw CancellationException()
        val n = input.read(buf)
        if (n < 0) break
        total += n
        var start = 0
        for (i in 0 until n) {
            if (buf[i] == 0x0A.toByte()) {
                if (pending.size() == 0) handle(buf.copyOfRange(start, i + 1), i + 1 - start)
                else {
                    pending.write(buf, start, i + 1 - start)
                    handle(pending.toByteArray(), pending.size())
                    pending.reset()
                }
                start = i + 1
            }
        }
        pending.write(buf, start, n - start)
        onBytes?.invoke(total)
    }
    if (pending.size() > 0) handle(pending.toByteArray(), pending.size())
    return Loaded(msgs, bad, blank)
}

/** "sms", "mms", or null for a record that is neither. */
fun classify(o: Any?): String? {
    if (o !is JObj) return null
    if (pick(o, K_PARTS) != null || o.has("msg_box") || o.has("m_type")) return "mms"
    if (o.has("body") || o.has("address")) return "sms"
    return null
}

fun load(src: Source, onBytes: ((Long) -> Unit)? = null, cancelled: () -> Boolean = { false }): Loaded =
    src.load(onBytes, cancelled)

// ------------------------------------------------------------------------- planning

/** A participant set: sorted, without duplicates (JSON.stringify of the sorted Set in JS). */
private fun setKey(keys: Collection<String>): List<String> = keys.toSet().sorted()

private fun cmpStrings(a: List<String>, b: List<String>): Int {
    for (i in 0 until minOf(a.size, b.size)) {
        val c = a[i].compareTo(b[i])
        if (c != 0) return c
    }
    return a.size - b.size
}

/** Decisions that need the whole export: the owner's number and each MMS's conversation. */
class Plan(val msgs: List<Msg>, ownerOverride: String?) {
    val owner: Set<String>
    val ownerHow: String
    private val names = HashMap<String, String>()
    private val problems = HashMap<Msg, String?>()
    private val threadLists: Map<String, List<String>>

    init {
        val (o, how) = detectOwner(ownerOverride)
        owner = o
        ownerHow = how
        for (m in msgs) {
            for (r in if (m.isSms) listOf(m.o) else m.addrRows) {
                val name = pick(r, K_NAME)
                val a = sval(r, "address")
                if (name is String && name.isNotEmpty() && !a.isNullOrEmpty() && addrKey(a) !in names) names[addrKey(a)] = name
            }
        }
        threadLists = conversationAddresses()
    }

    private fun detectOwner(override: String?): Pair<Set<String>, String> {
        if (!override.isNullOrEmpty()) {
            return override.split(',').filter { it.trim(::isSpace).isNotEmpty() }.map(::addrKey).toSet() to "set manually"
        }
        val senders = LinkedHashMap<String, Int>()
        for (m in msgs) {
            if (!m.isMms || sval(m.o, "msg_box") != "2") continue
            for (r in m.addrRows) {
                val a = sval(r, "address")
                if (sval(r, "type") == "137" && !a.isNullOrEmpty() && a != INSERT_TOKEN) {
                    senders[addrKey(a)] = (senders[addrKey(a)] ?: 0) + 1
                }
            }
        }
        if (senders.isNotEmpty()) return senders.keys to "the sender (\"From\") of the sent MMS"
        val received = LinkedHashMap<String, Int>()
        var n = 0
        for (m in msgs) {
            if (!m.isMms || sval(m.o, "msg_box") != "1") continue
            n += 1
            val keys = LinkedHashSet<String>()
            for (r in m.addrRows) if (sval(r, "type") != "137") keys.add(addrKey(sval(r, "address")))
            for (k in keys) received[k] = (received[k] ?: 0) + 1
        }
        if (received.isNotEmpty()) {
            val ranked = received.entries.sortedByDescending { it.value }
            val (k, c) = ranked[0]
            if (c >= 0.5 * n && (ranked.size == 1 || ranked[1].value < c)) {  // a tie is ambiguous
                return setOf(k) to "the recipient of most received MMS"
            }
        }
        return emptySet<String>() to "not found (set it manually)"
    }

    /** Everyone in an MMS's From/To/Cc/Bcc headers except the phone's owner, as written. */
    fun others(m: Msg): List<String> {
        val out = ArrayList<String>()
        val seen = HashSet<String>()
        for (r in m.addrRows) {
            val a = sval(r, "address")
            if (a.isNullOrEmpty() || a == INSERT_TOKEN) continue
            val k = addrKey(a)
            if (k !in owner && seen.add(k)) out.add(a)
        }
        return out
    }

    private fun ownAddress(m: Msg): List<String> {
        for (r in m.addrRows) {
            val a = sval(r, "address")
            if (!a.isNullOrEmpty() && a != INSERT_TOKEN) return listOf(a)
        }
        return emptyList()
    }

    /** For each old conversation (thread_id): the participants most of its MMS list. Every
     *  MMS of the conversation gets this list as its "address" attribute, which Android uses
     *  on restore to put the message into a conversation. */
    private fun conversationAddresses(): Map<String, List<String>> {
        val byThread = LinkedHashMap<String, MutableList<Msg>>()
        for (m in msgs) {
            val t = sval(m.o, "thread_id")
            if (!m.isMms || t == null) continue
            byThread.getOrPut(t) { ArrayList() }.add(m)
        }
        val lists = HashMap<String, List<String>>()
        for ((t, ms) in byThread) {
            val keyed = ms.map { setKey(others(it).map(::addrKey)) to it }
            val counts = LinkedHashMap<List<String>, Int>()
            for ((k) in keyed) counts[k] = (counts[k] ?: 0) + 1
            var best: List<String>? = null
            for (k in counts.keys) {
                if (best == null) {
                    best = k
                    continue
                }
                var c = counts[k]!!.compareTo(counts[best]!!)
                if (c == 0) c = k.size.compareTo(best.size)
                if (c == 0) c = cmpStrings(k, best)
                if (c > 0) best = k
            }
            var rep: Msg? = null
            for ((k, m) in keyed) {
                if (k != best) continue
                val c = if (rep == null) -1 else m.dateOrZero.compareTo(rep.dateOrZero)
                if (rep == null || c < 0 || (c == 0 && m.line < rep.line)) rep = m
            }
            val list = others(rep!!)
            lists[t] = list.ifEmpty { ownAddress(rep) }
        }
        return lists
    }

    fun addressList(m: Msg): List<String> {
        val t = sval(m.o, "thread_id")
        if (t != null) threadLists[t]?.let { return it }
        return others(m).ifEmpty { ownAddress(m) }
    }

    fun contactNames(m: Msg, addresses: List<String>): String {
        val own = HashMap<String, String>()
        for (r in m.addrRows) {
            val name = pick(r, K_NAME)
            val a = sval(r, "address")
            if (name is String && name.isNotEmpty() && !a.isNullOrEmpty() && addrKey(a) !in own) own[addrKey(a)] = name
        }
        return addresses.joinToString(", ") { own[addrKey(it)] ?: names[addrKey(it)] ?: "(Unknown)" }
    }

    /** Why a record cannot be written as a restorable message, or null. */
    fun problem(m: Msg): String? {
        if (m !in problems) problems[m] = findProblem(m)
        return problems[m]
    }

    private fun findProblem(m: Msg): String? {
        val o = m.o
        if (m.isSms) {
            for (k in listOf("address", "date", "type")) if (sval(o, k).isNullOrEmpty()) return "no \"$k\" value"
            if (!isInt(sval(o, "date"))) return "\"date\" is not a number"
            return null
        }
        if (!isInt(sval(o, "date"))) return "no numeric \"date\" value"
        if (sval(o, "msg_box").isNullOrEmpty()) return "no \"msg_box\" value"
        if (addressList(m).isEmpty()) return "no sender or recipient address"
        return null
    }
}

/** A body worth testing: XML-escaped characters or a character outside the BMP (an emoji).
 *  Not a Regex: Java matches surrogate pairs as one code point, JavaScript does not. */
private fun hasMedia(body: String): Boolean {
    for (i in body.indices) {
        val c = body[i]
        if (c == '\n' || c == '&' || c == '<' || c == '>' || c == '"') return true
        if (Character.isHighSurrogate(c) && i + 1 < body.length && Character.isLowSurrogate(body[i + 1])) return true
    }
    return false
}

private fun cmpInts(a: List<Int>, b: List<Int>): Int {
    for (i in 0 until minOf(a.size, b.size)) if (a[i] != b[i]) return a[i].compareTo(b[i])
    return a.size - b.size
}

/** A small, representative test set; the same selection as the Python version. */
fun pickSample(msgs: List<Msg>, plan: Plan, byChat: Boolean = false): List<Msg> {
    val byThread = LinkedHashMap<String?, MutableList<Msg>>()
    for (m in msgs) byThread.getOrPut(if (byChat) chatKey(plan, m) else sval(m.o, "thread_id")) { ArrayList() }.add(m)
    fun media(m: Msg) = m.isMms && m.parts.any { partFile(it) != null }
    fun group(m: Msg) = m.isMms && plan.addressList(m).size > 1
    fun newest(ms: List<Msg>) = ms.sortedWith { a, b -> b.dateOrZero.compareTo(a.dateOrZero) }
    fun box(m: Msg) = sval(m.o, "msg_box")

    val chosen = ArrayList<Msg>()
    var best: Pair<List<Int>, String>? = null
    for ((t, ms) in byThread) {
        val sms = ms.filter { it.isSms }
        val mms = ms.filter { it.isMms }
        if (t == null || mms.any(::group)) continue
        val score = listOf(listOf("1", "2").count { b -> mms.any { media(it) && box(it) == b } },
            sms.map { sval(it.o, "type") }.toSet().size, ms.size)
        if (best == null || cmpInts(score, best.first) > 0) best = score to t
    }
    if (best != null) {
        val ms = newest(byThread[best.second]!!)
        val sms = ms.filter { it.isSms }
        val picked = ArrayList(sms.take(10))
        for (typ in listOf("1", "2")) {
            if (picked.none { sval(it.o, "type") == typ }) picked.addAll(sms.filter { sval(it.o, "type") == typ }.take(1))
        }
        picked.addAll(sms.filter { it !in picked && hasMedia(sval(it.o, "body") ?: "") }.take(3))
        for (b in listOf("1", "2")) picked.addAll(ms.filter { media(it) && box(it) == b }.take(1))
        picked.addAll(ms.filter { it.isMms && !media(it) }.take(1))
        chosen.addAll(picked)
    }
    var biggest: Pair<Int, String>? = null
    for ((t, ms) in byThread) {
        if (t == null || !ms.any(::group)) continue
        if (biggest == null || ms.size > biggest.first || (ms.size == biggest.first && t > biggest.second)) biggest = ms.size to t
    }
    if (biggest != null) {
        val ms = newest(byThread[biggest.second]!!.filter { it.isMms })
        chosen.addAll(ms.filter { media(it) && box(it) == "1" }.take(1))
        chosen.addAll(ms.filter { !media(it) && box(it) == "1" }.take(2))
        chosen.addAll(ms.filter { box(it) == "2" }.take(1))
    }
    val unique = HashMap<Int, Msg>()
    for (m in chosen) unique[m.line] = m
    return unique.keys.sorted().map { unique[it]!! }
}

// ------------------------------------------------------------------------- convert

/** A field that had characters XML cannot hold. */
class Change(val line: Int, val kind: String, val field: String, val count: Int, val chars: List<String>)

class Converter(private val src: Source, private val plan: Plan, private val opts: Options) {
    val changes = ArrayList<Change>()
    val notes = HashMap<Int, MutableList<String>>()  // line -> notes for the manifest and report
    var attachments = 0
    var attachmentBytes = 0L
    var attachmentsEmpty = 0
    var attachmentsMissing = 0
    var mmsAddressFromConversation = 0
    /** SHA-256 of every attachment file written, for the verification. */
    val digests = HashMap<String, String>()

    fun note(line: Int, text: String) {
        notes.getOrPut(line) { ArrayList() }.add(text)
    }

    private fun text(value: String, m: Msg, field: String): String {
        var v = value
        val found = if (v.isEmpty()) emptyList() else illegalIn(v)
        if (found.isNotEmpty()) {
            val chars = found.map { "U+" + it.toString(16).uppercase(Locale.ROOT).padStart(4, '0') }.toSet().sorted()
            changes.add(Change(m.line, m.kind, field, found.size, chars))
            note(m.line, "${found.size} character(s) " + chars.joinToString("/") + " " +
                (if (opts.nul == "strip") "removed" else "replaced by U+FFFD") + " from " + field)
            v = clean(v, opts.nul)!!
        }
        return esc(v)
    }

    internal fun tag(indent: String, name: String, attrs: List<Pair<String, String>>, m: Msg,
                     prefix: String = "", end: String = " />"): String {
        val s = StringBuilder(indent).append('<').append(name)
        for ((k, v) in attrs) s.append(' ').append(k).append("=\"").append(text(v, m, prefix + k)).append('"')
        return s.append(end).append('\n').toString()
    }

    fun sms(m: Msg): String {
        val o = m.o
        val attrs = ArrayList<Pair<String, String>>()
        for (k in SMS_ORDER) {
            val v: String? = when (k) {
                "sub_id" -> subIdFor(o, opts.subId)
                "readable_date" -> readable(m.dateMs, opts.tz)
                "contact_name" -> (pick(o, K_NAME) as? String)?.ifEmpty { null } ?: "(Unknown)"
                else -> sval(o, k) ?: if (k in SMS_OMIT) null else "null"
            }
            if (v != null) attrs.add(k to v)
        }
        return tag("  ", "sms", attrs, m)
    }

    fun mms(m: Msg): String {
        val o = m.o
        val attrs = ArrayList<Pair<String, String>>()
        val addresses = plan.addressList(m)
        val own = setKey(plan.others(m).map(::addrKey))
        if (own != setKey(addresses.map(::addrKey)) && own.isNotEmpty()) {
            note(m.line, "MMS headers list ${own.size} other participant(s); \"address\" uses the " +
                "${addresses.size} of its conversation so it stays in that conversation")
            mmsAddressFromConversation += 1
        }
        for (k in MMS_ORDER) {
            val v: String? = when (k) {
                "date" -> m.dateMs.toString()
                "address" -> addresses.joinToString("~")
                "sub_id" -> subIdFor(o, opts.subId)
                "readable_date" -> readable(m.dateMs, opts.tz)
                "contact_name" -> plan.contactNames(m, addresses)
                else -> sval(o, k) ?: if (k in MMS_OMIT) null else "null"
            }
            if (v != null) attrs.add(k to v)
        }
        val out = StringBuilder(tag("  ", "mms", attrs, m, "", ">")).append("    <parts>\n")
        for (p in writtenParts(m, opts)) {
            val line = tag("      ", "part", PART_ATTRS.map { it to (sval(p, it) ?: "null") }, m, "part.", "")
            out.append(line, 0, line.length - 1)
            val name = partFile(p)
            if (name != null) {
                attachments += 1
                if (name in src.names) {
                    val data = src.readPart(name)
                    out.append(" data=\"").append(Base64.getEncoder().encodeToString(data)).append('"')
                    attachmentBytes += data.size
                    digests.getOrPut(name) { digest(data) }
                    if (data.isEmpty()) {
                        attachmentsEmpty += 1
                        note(m.line, "attachment $name (${sval(p, "ct")}) is an empty (0-byte) file in the export")
                    }
                } else {
                    attachmentsMissing += 1
                    note(m.line, "attachment file $name (${sval(p, "ct")}) is not in the export; part written without data")
                }
            }
            out.append(" />\n")
        }
        out.append("    </parts>\n    <addrs>\n")
        for (r in m.addrRows) out.append(tag("      ", "addr", ADDR_ATTRS.map { it to (sval(r, it) ?: "null") }, m, "addr."))
        out.append("    </addrs>\n  </mms>\n")
        return out.toString()
    }
}

fun tzLabel(tz: String?) = tz ?: (localTimeZone() + " (this device's time zone)")

fun header(count: Int, options: Options, now: ZonedDateTime): String =
    "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?>\n" +
        "<!--Converted by $APP $VERSION on " + localStamp(now) +
        ". readable_date values are in " + tzLabel(options.tz) + ".-->\n" +
        "<?xml-stylesheet type=\"text/xsl\" href=\"sms.xsl\"?>\n" +
        "<smses count=\"$count\" backup_set=\"" + UUID.randomUUID() + "\" backup_date=\"" +
        now.toInstant().toEpochMilli() + "\" type=\"full\">\n"

// ------------------------------------------------------------------------- manifest and report

internal fun csvField(v: Any?): String {
    if (v == null) return ""
    val s = v.toString()
    return if (s.any { it == '"' || it == ',' || it == '\r' || it == '\n' }) "\"" + s.replace("\"", "\"\"") + "\"" else s
}

private fun <T> counted(items: List<T>, f: (T) -> String): String {
    val c = HashMap<String, Int>()
    for (x in items) {
        val k = f(x)
        c[k] = (c[k] ?: 0) + 1
    }
    return c.entries.sortedBy { it.key }.joinToString(", ") { it.key + " " + it.value }
}

internal fun grouped(n: Long) = String.format(Locale.US, "%,d", n)

/** Old conversations: thread_id values in an SMS Import / Export export; other formats
 *  have none, so their messages are grouped by participants. */
fun countConversations(src: Source, msgs: List<Msg>, plan: Plan): Int =
    if (src.format == "sie") msgs.map { sval(it.o, "thread_id") }.toSet().size
    else msgs.filter { plan.problem(it) == null }.map { chatKey(plan, it) }.toSet().size

/** Facts about the export, for the summary screen and the report. */
class Summary(
    val lines: Int, val blank: Int, val bad: Int,
    val sms: Int, val smsReceived: Int, val smsSent: Int,
    val mms: Int, val mmsReceived: Int, val mmsSent: Int,
    val parts: Int, val attachments: Int, val present: Int, val missing: Int, val empty: Int, val unreferenced: Int,
    val conversations: Int, val owner: List<String>, val ownerHow: String,
    val first: BigInteger?, val last: BigInteger?,
    val problems: List<Triple<Int, String, String>>,
    val text: List<String>,
)

fun summarize(src: Source, loaded: Loaded, plan: Plan): Summary {
    val msgs = loaded.msgs
    val sms = msgs.filter { it.isSms }
    val mms = msgs.filter { it.isMms }
    val allParts = mms.flatMap { it.parts }
    val refs = allParts.mapNotNull(::partFile)
    val found = refs.filter { it in src.names }
    val empty = found.count { src.partSize(it) == 0L }
    val dates = msgs.mapNotNull { it.dateMs }.filter { it.signum() != 0 }
    val min = dates.minOrNull()
    val max = dates.maxOrNull()
    val refSet = refs.toSet()
    val unreferenced = src.names.count { it !in refSet }
    val conversations = countConversations(src, msgs, plan)
    val lines = msgs.size + loaded.bad.size + loaded.blank
    val owner = plan.owner.sorted().map(::mask)
    return Summary(
        lines, loaded.blank, loaded.bad.size,
        sms.size, sms.count { it.direction == "received" }, sms.count { it.direction == "sent" },
        mms.size, mms.count { it.direction == "received" }, mms.count { it.direction == "sent" },
        allParts.size, refs.size, found.size, refs.size - found.size, empty, unreferenced,
        conversations, owner, plan.ownerHow, min, max,
        msgs.mapNotNull { m -> plan.problem(m)?.let { Triple(m.line, m.kind, it) } },
        listOf(
            "SOURCE",
            "  name:              ${src.label} (${src.kind})",
            "  format:            ${src.describe}",
            "  records:           $lines ${if (src.unit == "line") "lines" else "records"} (${loaded.blank} blank, ${loaded.bad.size} unreadable)",
            "  SMS:               ${sms.size} (" + counted(sms) { it.direction } + ")",
            "  MMS:               ${mms.size} (" + counted(mms) { it.direction } + ")",
            "  MMS parts:         ${allParts.size} (" + counted(allParts) {
                if (sval(it, "ct") == "application/smil") "SMIL" else if (partFile(it) != null) "attachment" else "text"
            } + ")",
            "  attachment files:  ${refs.size} referenced, ${found.size} present, ${refs.size - found.size} missing, " +
                "$empty empty (0 bytes); $unreferenced file(s) not referenced by any part",
            "  conversations:     $conversations " + if (src.format == "sie") "thread_id values" else "(by participants)",
            "  owner number:      " + owner.joinToString(", ").ifEmpty { "unknown" } + " (from ${plan.ownerHow})",
            if (min != null && max != null) "  dates:             " + utc(min, false) + " .. " + utc(max, false)
            else "  dates:             none",
            "  SIM sub_id values: " + counted(msgs) { sval(it.o, "sub_id") ?: "None" },
        ),
    )
}

/** Source fields with no place in the target format (reported, not hidden). */
fun notCarried(msgs: List<Msg>, options: Options): List<String> {
    class Known(val sms: Set<String>, val mms: Set<String>, val part: Set<String>, val addr: Set<String>)
    val known = when (options.to) {
        "fig" -> null  // every column is kept
        "wonder" -> Known(setOf("address", "body", "date", "date_sent", "type", "read", "seen"),
            (listOf("date", "read", "msg_box", "ct_t", "m_type", "seen") + K_PARTS + K_SENDER + K_RECIPS).toSet(),
            setOf("ct", "name", "cl", "text", "_data"), setOf("address", "type"))
        else -> Known((SMS_ORDER + K_NAME).toSet(), (MMS_ORDER + K_PARTS + K_SENDER + K_RECIPS + K_NAME).toSet(),
            (PART_ATTRS + "_data").toSet(), (ADDR_ATTRS + K_NAME).toSet())
    }
    val c = HashMap<String, Int>()
    fun add(k: String) {
        c[k] = (c[k] ?: 0) + 1
    }
    for (m in msgs) {
        if (known != null) {
            if (m.isSms) {
                for (k in m.o.keyList) if (k !in known.sms) add("sms.$k")
            } else {
                for (k in m.o.keyList) if (k !in known.mms) add("mms.$k")
                for (p in m.parts) for (k in p.keyList) if (k !in known.part) add("part.$k")
                for (r in m.addrRows) for (k in r.keyList) if (k !in known.addr) add("addr.$k")
            }
        }
        if (options.subId != "keep" && sval(m.o, "sub_id") != null) add(m.kind + ".sub_id (old phone value)")
    }
    val lines = arrayListOf("  source fields not stored in the ${if (options.to == "fig") "ZIP" else "XML"} (no matching field in its format,",
        "  or specific to the old phone; ids and sub_id are kept in the manifest):")
    val keys = c.keys.sorted()
    for (k in keys) lines.add("    " + k.padEnd(34) + " " + c[k])
    if (keys.isEmpty()) lines.add("    none")
    return lines
}
