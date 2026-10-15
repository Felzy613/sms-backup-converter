/* What is written, and how: the "what to keep" options, splitting a big output into
 * parts, the three output formats (SMS Backup & Restore XML, Fig / TAK and Wonder ZIPs),
 * the ZIP check after saving, and the manifest and report. The same rules as
 * cli/sie_to_sbr.py and assets/converter.js, so the files come out byte-identical. */
package com.smsconverter.sie2sbr.core

import java.io.BufferedWriter
import java.io.ByteArrayInputStream
import java.io.FilterOutputStream
import java.io.IOException
import java.io.OutputStream
import java.io.OutputStreamWriter
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.time.ZonedDateTime
import java.util.Locale
import java.util.concurrent.CancellationException
import java.util.zip.CRC32

// ------------------------------------------------------------------------- choosing

class Chosen(val problems: List<Pair<Msg, String>>, val ok: List<Msg>, val chosen: List<Msg>, val leftOut: Map<String, Int>)

/** Splits the records into problems and convertible ones, applies the "what to keep"
 *  options and picks the test sample (cli/sie_to_sbr.py's choose). */
fun choose(src: Source, loaded: Loaded, plan: Plan, options: Options): Chosen {
    val problems = ArrayList<Pair<Msg, String>>()
    val ok = ArrayList<Msg>()
    for (m in loaded.msgs) {
        val why = plan.problem(m)
        if (why != null) problems.add(m to why) else ok.add(m)
    }
    val kept = ArrayList<Msg>()
    val leftOut = linkedMapOf("sms" to 0, "mms" to 0, "groups" to 0, "pdf" to 0)
    fun count(k: String) {
        leftOut[k] = leftOut[k]!! + 1
    }
    for (m in ok) {
        when {
            options.keep == "sms" && !m.isSms -> count("mms")
            options.keep == "mms" && !m.isMms -> count("sms")
            options.noGroups && m.isMms && plan.addressList(m).size > 1 -> count("groups")
            else -> kept.add(m)
        }
    }
    val chosen = if (options.sample) pickSample(kept, plan, src.format != "sie") else kept
    if (options.noPdf) leftOut["pdf"] = chosen.filter { it.isMms }.sumOf { m -> m.parts.count { isPdf(it) } }
    return Chosen(problems, ok, chosen, leftOut)
}

/** The conversation a message is restored into: its participants, without the owner. */
fun chatKey(plan: Plan, m: Msg): String =
    if (m.isSms) addrKey(sval(m.o, "address"))
    else plan.addressList(m).map(::addrKey).toSet().sorted().joinToString(",")

/** About how many bytes the message takes in the output (attachments exactly). */
fun estimate(m: Msg, src: Source, options: Options): Long {
    val o = m.o
    if (m.isSms) return 200L + u8len(sval(o, "body")) + u8len(sval(o, "address"))
    var n = 1000L + 100L * m.addrRows.size
    for (p in writtenParts(m, options)) {
        n += 200 + u8len(sval(p, "text"))
        val name = partFile(p)
        if (name != null && name in src.names) {
            val size = src.partSize(name)
            n += if (options.to == "sbr") 4 * ((size + 2) / 3) else size
        }
    }
    return n
}

/** The messages of each output file. With splitMb, a conversation goes into one file
 *  whenever it fits, a message is never split, and files hold their messages in the
 *  original order; restored one after another, they give back every message. */
fun splitMessages(chosen: List<Msg>, src: Source, plan: Plan, options: Options): List<List<Msg>> {
    val limit = (options.splitMb * 1048576).toLong()
    if (limit <= 0) return listOf(chosen)
    val chats = LinkedHashMap<String, MutableList<Msg>>()
    for (m in chosen) chats.getOrPut(chatKey(plan, m)) { ArrayList() }.add(m)
    val parts = ArrayList<List<Msg>>()
    var cur = ArrayList<Msg>()
    var size = 0L
    for (ms in chats.values) {
        val sizes = ms.map { estimate(it, src, options) }
        if (cur.isNotEmpty() && size + sizes.sum() > limit) {
            parts.add(cur)
            cur = ArrayList()
            size = 0
        }
        for ((i, m) in ms.withIndex()) {
            if (cur.isNotEmpty() && size + sizes[i] > limit) {
                parts.add(cur)
                cur = ArrayList()
                size = 0
            }
            cur.add(m)
            size += sizes[i]
        }
    }
    if (cur.isNotEmpty()) parts.add(cur)
    val index = HashMap<Msg, Int>()
    chosen.forEachIndexed { i, m -> index[m] = i }
    return parts.map { p -> p.sortedBy { index[it]!! } }
}

/** Everything decided before writing: what is written and how it is split into files. */
class Job(
    val src: Source, val loaded: Loaded, val plan: Plan, val conv: Converter, val options: Options,
    val problems: List<Pair<Msg, String>>, val ok: List<Msg>, val chosen: List<Msg>, val leftOut: Map<String, Int>,
    val parts: List<List<Msg>>, val ids: Map<Msg, Pair<String, String>>?, val now: ZonedDateTime,
)

fun prepare(src: Source, loaded: Loaded, options: Options, now: ZonedDateTime = ZonedDateTime.now()): Job {
    val plan = Plan(loaded.msgs, options.owner)
    val c = choose(src, loaded, plan, options)
    return Job(src, loaded, plan, Converter(src, plan, options), options, c.problems, c.ok, c.chosen, c.leftOut,
        splitMessages(c.chosen, src, plan, options), if (options.to == "fig") figIds(c.chosen, plan) else null, now)
}

// ------------------------------------------------------------------------- writing

/** One written output file: its messages, size, and what a ZIP output holds (for the check). */
class PartOutput(val msgs: List<Msg>, val bytes: Long, val first: Pair<String, ByteArray>?,
                 val files: List<Pair<String, String>>)

private class CountingStream(out: OutputStream) : FilterOutputStream(out) {
    var count = 0L

    override fun write(b: Int) {
        out.write(b)
        count++
    }

    override fun write(b: ByteArray, off: Int, len: Int) {
        out.write(b, off, len)
        count += len
    }
}

/** Writes output file k (0-based) of the job to out, which is flushed, not closed.
 *  progress(done, total) counts messages (XML) or attachments (ZIP). */
fun writePart(job: Job, k: Int, out: OutputStream, progress: ((Int, Int) -> Unit)? = null,
              cancelled: () -> Boolean = { false }): PartOutput {
    val msgs = job.parts[k]
    val counting = CountingStream(out)
    if (job.options.to == "sbr") {
        val w = BufferedWriter(OutputStreamWriter(counting, Charsets.UTF_8), 1 shl 16)
        w.write(header(msgs.size, job.options, job.now))
        for ((i, m) in msgs.withIndex()) {
            if (cancelled()) throw CancellationException()
            w.write(if (m.isSms) job.conv.sms(m) else job.conv.mms(m))
            progress?.invoke(i + 1, msgs.size)
        }
        w.write("</smses>\n")
        w.flush()
        return PartOutput(msgs, counting.count, null, emptyList())
    }
    val (first, files) = if (job.options.to == "fig") figPart(msgs, job.src, job.options, job.conv, job.ids!!)
    else wonderPart(msgs, job.src, job.options, job.conv, job.now)
    val zip = ZipWriter(counting, job.now)
    zip.add(first.first, first.second)
    for ((i, f) in files.withIndex()) {
        if (cancelled()) throw CancellationException()
        zip.add(f.first, job.src.readPart(f.second))
        progress?.invoke(i + 1, files.size)
    }
    zip.close()
    counting.flush()
    return PartOutput(msgs, counting.count, first, files)
}

/** A column of a record or of a record being built, as sval does. */
private fun field(o: Any?, key: String): String? = when (o) {
    is JObj -> sval(o, key)
    is Map<*, *> -> when (val v = o[key]) {
        null, JNull, is JObj, is List<*>, is Map<*, *> -> null
        is Boolean -> if (v) "1" else "0"
        is String -> v
        else -> v.toString()
    }
    else -> null
}

private fun fileOf(p: Any?): String? {
    val d = field(p, "_data")
    if (d.isNullOrEmpty()) return null
    return d.replace('\\', '/').substringAfterLast('/').ifEmpty { null }
}

/** Counts an attachment and notes an empty or missing one (the same for every format). */
private fun attachmentNote(conv: Converter, m: Msg, ct: String?, name: String, present: Boolean, size: Long) {
    conv.attachments += 1
    if (!present) {
        conv.attachmentsMissing += 1
        conv.note(m.line, "attachment file $name ($ct) is not in the export; part written without data")
    } else {
        conv.attachmentBytes += size
        if (size == 0L) {
            conv.attachmentsEmpty += 1
            conv.note(m.line, "attachment $name ($ct) is an empty (0-byte) file in the export")
        }
    }
}

/** Row and thread ids for records that come from another format (Fig's importer, SMS
 *  Import / Export, expects them): numbered in the order written, threads by participants. */
fun figIds(chosen: List<Msg>, plan: Plan): Map<Msg, Pair<String, String>> {
    val ids = HashMap<Msg, Pair<String, String>>()
    val threads = HashMap<String, String>()
    chosen.forEachIndexed { i, m ->
        val key = chatKey(plan, m)
        val tid = threads.getOrPut(key) { (threads.size + 1).toString() }
        ids[m] = (i + 1).toString() to tid
    }
    return ids
}

private val RELATIONS = setOf("_id", "thread_id", "__sender_address", "__recipient_addresses", "__parts")
private val HUNDRED_BILLION = BigInteger.valueOf(100_000_000_000L)

/** messages.ndjson and its data/ files for one output file, as SMS Import / Export writes
 *  them. Records from an SMS Import / Export export are written back unchanged except for
 *  the options (SIM id, PDFs). */
private fun figPart(msgs: List<Msg>, src: Source, options: Options, conv: Converter,
                    ids: Map<Msg, Pair<String, String>>): Pair<Pair<String, ByteArray>, List<Pair<String, String>>> {
    val lines = ArrayList<String>()
    val files = ArrayList<Pair<String, String>>()
    val seen = HashSet<String>()
    var k = 0
    for (m in msgs) {
        val o = m.o
        val obj = LinkedHashMap<String, Any?>()
        if (src.format == "sie") {
            for (key in o.keyList) obj[key] = o[key]
            val key = K_PARTS.firstOrNull { obj[it] is List<*> }
            if (m.isMms && options.noPdf && key != null) obj[key] = (obj[key] as List<*>).filter { !(it is JObj && isPdf(it)) }
            if (options.subId != "keep") obj["sub_id"] = subIdFor(o, options.subId)
        } else {
            val (rid, tid) = ids[m]!!
            obj["_id"] = rid
            obj["thread_id"] = tid
            for (key in o.keyList) if (key !in RELATIONS) obj[key] = o[key]
            if (options.subId != "keep") obj["sub_id"] = subIdFor(o, options.subId)
            if (m.isMms) {
                val d = sval(o, "date")
                if (isInt(d) && BigInteger(d) >= HUNDRED_BILLION) obj["date"] = floorDiv1000(BigInteger(d)).toString()
                val sender = o["__sender_address"]
                if (sender is JObj) obj["__sender_address"] = sender.toMap().also { it["msg_id"] = rid }
                obj["__recipient_addresses"] = ((o["__recipient_addresses"] as? List<*>) ?: emptyList<Any?>())
                    .filterIsInstance<JObj>().map { r -> r.toMap().also { it["msg_id"] = rid } }
                obj["__parts"] = writtenParts(m, options).map { p -> p.toMap().also { it["mid"] = rid } }
            }
        }
        if (m.isMms) {
            val parts = K_PARTS.map { obj[it] }.firstOrNull { it != null && it !== JNull }
            for (p in (parts as? List<*>) ?: emptyList<Any?>()) {
                if (p !is JObj && p !is Map<*, *>) continue
                val name = fileOf(p) ?: continue
                val present = name in src.names
                attachmentNote(conv, m, field(p, "ct"), name, present, if (present) src.partSize(name) else 0)
                if (src.format == "sie") {
                    if (present && seen.add(name)) files.add("data/$name" to name)
                } else {
                    @Suppress("UNCHECKED_CAST") val part = p as MutableMap<String, Any?>
                    if (present) {
                        k += 1
                        part["_data"] = APP_PARTS + "PART_$k"
                        files.add("data/PART_$k" to name)
                    } else {
                        part.remove("_data")
                    }
                }
            }
        }
        lines.add(StringBuilder().also { jsonTo(it, obj) }.toString())
    }
    return ("messages.ndjson" to (lines.joinToString("\n") + "\n").toByteArray(Charsets.UTF_8)) to files
}

private fun extFor(ct: String?, label: String?): String {
    val base = (ct ?: "").split(';')[0].trim().lowercase(Locale.ROOT)
    EXTENSIONS[base]?.let { return it }
    val m = Regex("\\.([A-Za-z0-9]{1,5})$").find(label ?: "")
    return m?.groupValues?.get(1)?.lowercase(Locale.ROOT) ?: "bin"
}

private fun wonderSmil(refs: List<Pair<String, String>>): String {
    val body = refs.joinToString("") { (ct, label) ->
        val tag = when {
            ct.startsWith("image/") -> "img"
            ct.startsWith("video/") -> "video"
            ct.startsWith("audio/") -> "audio"
            else -> "ref"
        }
        "<par dur=\"5000ms\"><$tag src=\"" + esc(label) + "\" region=\"Image\"/></par>"
    }
    return "<smil><head><layout><root-layout/><region id=\"Image\" fit=\"meet\" top=\"0\" left=\"0\" height=\"100%\" " +
        "width=\"100%\"/></layout></head><body>$body</body></smil>"
}

private fun or(v: String?, fallback: String): String = if (v.isNullOrEmpty()) fallback else v

/** The XML file and mms_attachments/ files of a Wonder backup. */
private fun wonderPart(msgs: List<Msg>, src: Source, options: Options, conv: Converter,
                       now: ZonedDateTime): Pair<Pair<String, ByteArray>, List<Pair<String, String>>> {
    val out = StringBuilder("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<messages sms_count=\"${msgs.count { it.isSms }}\" " +
        "mms_count=\"${msgs.count { it.isMms }}\">\n")
    val files = ArrayList<Pair<String, String>>()
    var nMms = 0
    var k = 0
    for (m in msgs) {
        val o = m.o
        if (m.isSms) {
            out.append(conv.tag("  ", "sms", listOf("address" to or(sval(o, "address"), ""), "body" to or(sval(o, "body"), ""),
                "date" to sval(o, "date")!!, "date_sent" to or(sval(o, "date_sent"), "0"), "type" to sval(o, "type")!!,
                "read" to or(sval(o, "read"), "1"), "seen" to or(sval(o, "seen"), "1")), m))
            continue
        }
        nMms += 1
        val box = sval(o, "msg_box")!!
        out.append(conv.tag("  ", "mms", listOf("date" to floorDiv1000(m.dateMs!!).toString(), "read" to or(sval(o, "read"), "1"),
            "msg_box" to box, "ct_t" to or(sval(o, "ct_t"), "application/vnd.wap.multipart.related"),
            "m_type" to or(sval(o, "m_type"), if (box == "1") "132" else "128"), "seen" to or(sval(o, "seen"), "1")), m, "", ">"))
        for (r in m.addrRows) {
            out.append(conv.tag("    ", "addr", listOf("address" to or(sval(r, "address"), ""), "type" to or(sval(r, "type"), "151")),
                m, "addr."))
        }
        val parts = ArrayList<String>()
        val refs = ArrayList<Pair<String, String>>()
        val ps = writtenParts(m, options)
        for (p in ps) {
            val ct = or(sval(p, "ct"), "application/octet-stream")
            var label = sval(p, "cl").takeUnless { it.isNullOrEmpty() } ?: sval(p, "name")
            val name = partFile(p)
            val present = name != null && name in src.names
            if (name != null) attachmentNote(conv, m, sval(p, "ct"), name, present, if (present) src.partSize(name) else 0)
            if (present) {
                k += 1
                val fn = "mms_${nMms}_$k." + extFor(ct, label)
                if (label.isNullOrEmpty()) label = fn
                parts.add(conv.tag("    ", "part", listOf("ct" to ct, "name" to label, "cl" to label, "file" to fn), m, "part."))
                files.add("mms_attachments/$fn" to name!!)
                refs.add(ct to label)
            } else {
                val attrs = arrayListOf("ct" to or(sval(p, "ct"), "text/plain"))
                if (!label.isNullOrEmpty()) {
                    attrs.add("name" to label)
                    attrs.add("cl" to label)
                }
                sval(p, "text")?.let { attrs.add("text" to it) }
                parts.add(conv.tag("    ", "part", attrs, m, "part."))
            }
        }
        if (refs.isNotEmpty() && ps.none { sval(it, "ct") == "application/smil" }) {
            parts.add(0, conv.tag("    ", "part", listOf("ct" to "application/smil", "name" to "smil.xml", "cl" to "smil.xml",
                "text" to wonderSmil(refs)), m, "part."))
        }
        for (x in parts) out.append(x)
        out.append("  </mms>\n")
    }
    out.append("</messages>\n")
    val ymd = "%04d-%02d-%02d".format(Locale.ROOT, now.year, now.monthValue, now.dayOfMonth)
    return ("Messages_Backup_$ymd.xml" to out.toString().toByteArray(Charsets.UTF_8)) to files
}

/** Writes a ZIP archive of stored (uncompressed) entries with their sizes in the local
 *  headers and no data descriptors, which every importer accepts (Fig's rejects some other
 *  ZIP layouts); ZIP64 records only when an archive needs them. The same bytes as
 *  cli/sie_to_sbr.py's ZipWriter. */
class ZipWriter(private val out: OutputStream, now: ZonedDateTime) {
    private class Entry(val name: ByteArray, val crc: Long, val size: Long, val offset: Long)

    private val entries = ArrayList<Entry>()
    private var offset = 0L
    private val time: Int
    private val date: Int

    init {
        val year = now.year.coerceIn(1980, 2107)
        time = (now.hour shl 11) or (now.minute shl 5) or (now.second / 2)
        date = ((year - 1980) shl 9) or (now.monthValue shl 5) or now.dayOfMonth
    }

    private fun buffer(n: Int) = ByteBuffer.allocate(n).order(ByteOrder.LITTLE_ENDIAN)

    fun add(name: String, data: ByteArray) {
        val nb = name.toByteArray(Charsets.UTF_8)
        val crc = CRC32().apply { update(data) }.value
        val size = data.size.toLong()
        val big = size >= MAX || offset >= MAX
        val h = buffer(30 + nb.size + if (big) 20 else 0)
        h.putInt(0x04034b50).putShort((if (big) 45 else 20).toShort()).putShort(0x0800).putShort(0)
            .putShort(time.toShort()).putShort(date.toShort()).putInt(crc.toInt())
            .putInt((if (big) MAX else size).toInt()).putInt((if (big) MAX else size).toInt())
            .putShort(nb.size.toShort()).putShort((if (big) 20 else 0).toShort()).put(nb)
        if (big) h.putShort(1).putShort(16).putLong(size).putLong(size)
        out.write(h.array())
        out.write(data)
        entries.add(Entry(nb, crc, size, offset))
        offset += h.capacity() + size
    }

    /** Writes the central directory; out stays open. */
    fun close() {
        val start = offset
        var cdSize = 0L
        for (e in entries) {
            val big = e.size >= MAX || e.offset >= MAX
            val h = buffer(46 + e.name.size + if (big) 28 else 0)
            h.putInt(0x02014b50).putShort((if (big) 45 else 20).toShort()).putShort((if (big) 45 else 20).toShort())
                .putShort(0x0800).putShort(0).putShort(time.toShort()).putShort(date.toShort()).putInt(e.crc.toInt())
                .putInt((if (big) MAX else e.size).toInt()).putInt((if (big) MAX else e.size).toInt())
                .putShort(e.name.size.toShort()).putShort((if (big) 28 else 0).toShort()).putShort(0).putShort(0)
                .putShort(0).putInt(0).putInt((if (big) MAX else e.offset).toInt()).put(e.name)
            if (big) h.putShort(1).putShort(24).putLong(e.size).putLong(e.size).putLong(e.offset)
            out.write(h.array())
            cdSize += h.capacity()
        }
        val n = entries.size.toLong()
        val big = n >= 0xFFFF || start >= MAX || cdSize >= MAX
        if (big) {
            val z = buffer(76)
            z.putInt(0x06064b50).putLong(44).putShort(45).putShort(45).putInt(0).putInt(0).putLong(n).putLong(n)
                .putLong(cdSize).putLong(start)
            z.putInt(0x07064b50).putInt(0).putLong(start + cdSize).putInt(1)
            out.write(z.array())
        }
        val t = buffer(22)
        t.putInt(0x06054b50).putShort(0).putShort(0).putShort((if (big) 0xFFFF else n.toInt()).toShort())
            .putShort((if (big) 0xFFFF else n.toInt()).toShort()).putInt((if (big) MAX else cdSize).toInt())
            .putInt((if (big) MAX else start).toInt()).putShort(0)
        out.write(t.array())
    }

    private companion object {
        const val MAX = 0xFFFFFFFFL
    }
}

/** JSON text exactly as JavaScript's JSON.stringify writes it (no spaces). */
fun jsonTo(b: StringBuilder, v: Any?) {
    when (v) {
        null, JNull -> b.append("null")
        is Boolean -> b.append(if (v) "true" else "false")
        is JNum -> b.append(v.asString)
        is String -> jsonString(b, v)
        is JObj -> {
            b.append('{')
            for ((i, k) in v.keyList.withIndex()) {
                if (i > 0) b.append(',')
                jsonString(b, k)
                b.append(':')
                jsonTo(b, v[k])
            }
            b.append('}')
        }
        is Map<*, *> -> {
            b.append('{')
            var first = true
            for ((k, x) in v) {
                if (!first) b.append(',')
                first = false
                jsonString(b, k.toString())
                b.append(':')
                jsonTo(b, x)
            }
            b.append('}')
        }
        is List<*> -> {
            b.append('[')
            for ((i, x) in v.withIndex()) {
                if (i > 0) b.append(',')
                jsonTo(b, x)
            }
            b.append(']')
        }
        else -> b.append(v.toString())
    }
}

private fun jsonString(b: StringBuilder, s: String) {
    b.append('"')
    var i = 0
    while (i < s.length) {
        val c = s[i]
        when {
            c == '"' -> b.append("\\\"")
            c == '\\' -> b.append("\\\\")
            c == '\b' -> b.append("\\b")
            c == '\u000C' -> b.append("\\f")
            c == '\n' -> b.append("\\n")
            c == '\r' -> b.append("\\r")
            c == '\t' -> b.append("\\t")
            c < ' ' -> b.append("\\u%04x".format(c.code))
            Character.isHighSurrogate(c) && i + 1 < s.length && Character.isLowSurrogate(s[i + 1]) -> {
                b.append(c).append(s[i + 1])
                i++
            }
            Character.isSurrogate(c) -> b.append("\\u%04x".format(c.code))
            else -> b.append(c)
        }
        i++
    }
    b.append('"')
}

/** Re-reads a saved ZIP output: every entry's CRC-32, the message file byte for byte, every
 *  attachment by SHA-256, and the messages read back with this converter's own reader. */
fun verifyZip(input: RandomInput, job: Job, part: PartOutput): Verification {
    val errors = ArrayList<String>()
    var checked = 0
    val (firstName, firstBytes) = part.first!!
    try {
        val zip = ZipArchive(input)
        val want = listOf(firstName) + part.files.map { it.first }
        if (zip.names != want) errors.add("the ZIP holds ${zip.names.size} entries, expected ${want.size}")
        else if (!zip.read(firstName).contentEquals(firstBytes)) errors.add("$firstName differs from what was written")
        else {
            val hashes = HashMap<String, String>()
            for ((entry, name) in part.files) {
                val want1 = hashes.getOrPut(name) { digestOf(job.src.readPart(name)) }
                if (digestOf(zip.read(entry)) != want1) errors.add("attachment $entry differs from the source file $name")
                else checked++
            }
        }
    } catch (e: IOException) {
        errors.add("not a readable ZIP file: " + e.message)
    }
    var backSms = 0
    var backMms = 0
    if (errors.isEmpty()) {
        try {
            if (job.options.to == "fig") {
                val r = parseNdjson(ByteArrayInputStream(firstBytes))
                backSms = r.msgs.count { it.isSms }
                backMms = r.msgs.count { it.isMms }
                if (r.bad.isNotEmpty()) errors.add("${r.bad.size} line(s) of messages.ndjson could not be read back")
            } else {
                val back = XmlBackupSource("wonder", firstName, "file", listOf { ByteArrayInputStream(firstBytes) }, null, null,
                    firstBytes.size.toLong())
                back.use {
                    val r = it.load()
                    backSms = r.msgs.count { m -> m.isSms }
                    backMms = r.msgs.count { m -> m.isMms }
                }
            }
        } catch (e: Exception) {
            errors.add("the written $firstName could not be read back: " + e.message)
        }
    }
    val wantSms = part.msgs.count { it.isSms }
    val wantMms = part.msgs.count { it.isMms }
    if (errors.isEmpty() && (backSms != wantSms || backMms != wantMms)) {
        errors.add("read back $backSms SMS + $backMms MMS, expected $wantSms SMS + $wantMms MMS")
    }
    val lines = arrayListOf(
        "VERIFICATION (the saved ZIP re-read: every entry's CRC-32, the ${if (job.options.to == "fig") "message file" else "XML file"} " +
            "byte for byte, every attachment",
        "              by SHA-256, and the messages read back with this converter's ${TARGET_NAMES[job.options.to]} reader)",
        "  messages read back:       $backSms SMS + $backMms MMS (written $wantSms SMS + $wantMms MMS)",
        "  attachments checked:      $checked",
        "  result: " + if (errors.isEmpty()) "PASSED" else "FAILED")
    for (e in errors) lines.add("    ! $e")
    return Verification(errors.isEmpty(), errors, lines, 0, 0, emptyList())
}

// ------------------------------------------------------------------------- manifest and report

/** One row per message written to one output file (msgs), identical to the Python
 *  version's .manifest.csv. */
fun manifest(job: Job, msgs: List<Msg>): String {
    val b = StringBuilder()
    b.append(listOf("xml_index", "kind", "direction", "source_line", "source_id", "source_thread_id", "source_sub_id",
        "written_sub_id", "date_ms", "date_utc", "address_written", "parts", "attachments", "notes").joinToString(",")).append("\r\n")
    for ((i, m) in msgs.withIndex()) {
        val o = m.o
        val parts = if (m.isMms) writtenParts(m, job.options) else emptyList()
        val row = listOf(i + 1, m.kind, m.direction, m.line, sval(o, "_id"), sval(o, "thread_id"), sval(o, "sub_id"),
            subIdFor(o, job.options.subId), m.dateMs, utc(m.dateMs!!),
            if (m.isMms) job.plan.addressList(m).joinToString("~") else sval(o, "address"),
            if (m.isMms) parts.size else "", if (m.isMms) parts.count { partFile(it) != null } else "",
            (job.conv.notes[m.line] ?: emptyList<String>()).joinToString("; "))
        b.append(row.joinToString(",") { csvField(it) }).append("\r\n")
    }
    return b.toString()
}

/** One saved output file, for the report. */
class WrittenFile(val name: String, val bytes: Long, val verification: Verification?)

fun describeFilters(options: Options, leftOut: Map<String, Int>): String {
    val out = ArrayList<String>()
    if (options.keep == "sms") out.add("text messages (SMS) only, ${leftOut["mms"]} MMS left out")
    else if (options.keep == "mms") out.add("picture and group messages (MMS) only, ${leftOut["sms"]} SMS left out")
    if (options.noGroups) out.add("${leftOut["groups"]} group MMS left out")
    if (options.noPdf) out.add("${leftOut["pdf"]} PDF attachment(s) left out")
    return out.joinToString("; ").ifEmpty { "none (everything is kept)" }
}

/** The conversion report (.report.txt). */
fun report(job: Job, files: List<WrittenFile>): String {
    val conv = job.conv
    val options = job.options
    val src = job.src
    val unit = src.unit
    val lines = ArrayList<String>()
    lines.add("Message backup conversion report ($APP $VERSION for Android): " + src.describe.substringBefore(':') +
        " -> " + TARGET_NAMES[options.to])
    lines.add("generated " + localStamp(job.now))
    lines.add("")
    lines.addAll(summarize(src, job.loaded, job.plan).text)
    lines.addAll(listOf("", "CONVERSION", "  output format:     " + TARGET_NAMES[options.to]))
    for (f in files) lines.add("  output:            ${f.name} (" + grouped(f.bytes) + " bytes)")
    if (files.size > 1) {
        lines.add("  parts:             ${files.size} files of at most about ${options.splitMb} MB; restore them in order, part 1 first")
    }
    val chosen = job.chosen
    val bad = job.loaded.bad
    lines.addAll(listOf(
        "  mode:              " + if (options.sample) "test sample" else "all messages",
        "  kept:              " + describeFilters(options, job.leftOut),
        "  written:           ${chosen.count { it.isSms }} SMS + ${chosen.count { it.isMms }} MMS = ${chosen.size} messages",
        "  attachments:       ${conv.attachments - conv.attachmentsMissing} written (" + grouped(conv.attachmentBytes) +
            " bytes), ${conv.attachmentsEmpty} empty in the export, ${conv.attachmentsMissing} missing from the export",
        "  not convertible:   ${job.problems.size + bad.size} record(s)" + if (job.problems.isNotEmpty() || bad.isNotEmpty()) "" else " (none)"))
    for ((m, why) in job.problems) lines.add("    $unit ${m.line} (${m.kind}): $why")
    for ((line, why) in bad) lines.add("    $unit $line: $why")
    lines.add("  sub_id (SIM):      " + when (options.subId) {
        "unknown" -> "written as -1 (\"SIM unknown\") for every message; the old phone's values are in the manifest"
        "keep" -> "the old phone's values written unchanged"
        else -> "written as ${options.subId} for every message"
    })
    lines.add("  text changes:      ${conv.changes.size} field(s) had characters XML cannot store (" +
        (if (options.nul == "strip") "removed" else "replaced by U+FFFD") + ")" + if (conv.changes.isNotEmpty()) "" else " - none")
    for (c in conv.changes) lines.add("    $unit ${c.line} (${c.kind} ${c.field}): ${c.count} x " + c.chars.joinToString("/"))
    if (options.to == "sbr") {
        lines.add("  MMS whose \"address\" comes from their conversation (headers list fewer people): ${conv.mmsAddressFromConversation}")
        for (m in chosen) {
            if ((conv.notes[m.line] ?: emptyList<String>()).any { it.startsWith("MMS headers") }) {
                lines.add("    $unit ${m.line} (thread ${sval(m.o, "thread_id")})")
            }
        }
    }
    for (m in chosen) for (n in conv.notes[m.line] ?: emptyList<String>()) if ("attachment" in n) lines.add("    $unit ${m.line}: $n")
    lines.addAll(notCarried(chosen, options))
    lines.add("")
    for ((i, f) in files.withIndex()) {
        if (files.size > 1) lines.add("PART ${i + 1} of ${files.size}: ${f.name} (${job.parts[i].size} messages)")
        f.verification?.let {
            lines.addAll(it.lines)
            lines.add("")
        }
    }
    return lines.joinToString("\n").trimEnd('\n') + "\n"
}
