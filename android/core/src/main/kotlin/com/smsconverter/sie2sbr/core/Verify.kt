package com.smsconverter.sie2sbr.core

import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.SAXParseException
import org.xml.sax.helpers.DefaultHandler
import java.io.BufferedInputStream
import java.io.FilterInputStream
import java.io.InputStream
import java.math.BigInteger
import java.util.Base64
import java.util.concurrent.CancellationException
import javax.xml.parsers.SAXParserFactory

class Verification(
    val ok: Boolean,
    val errors: List<String>,
    val lines: List<String>,
    val conversations: Int,
    val oldConversations: Int,
    val split: List<Pair<String?, Int>>,
)

private val SMS_CHECKED = listOf("address", "date", "type", "body", "read", "status", "date_sent", "protocol", "locked",
    "subject", "service_center", "toa", "sc_toa", "sub_id")

private fun expectedSms(m: Msg, opts: Options): List<String?> {
    val o = m.o
    fun get(k: String, fb: String?) = sval(o, k)?.let { clean(it, opts.nul) } ?: fb
    return listOf(get("address", null), get("date", null), get("type", null), get("body", "null"), get("read", "null"),
        get("status", "null"), get("date_sent", null), get("protocol", null), get("locked", null), get("subject", "null"),
        get("service_center", "null"), get("toa", "null"), get("sc_toa", "null"), subIdFor(o, opts.subId))
}

private fun expectedMms(m: Msg, opts: Options): List<Any?> {
    val o = m.o
    fun v(r: JObj, k: String) = sval(r, k)?.let { clean(it, opts.nul) } ?: "null"
    return listOf(m.dateMs.toString(), subIdFor(o, opts.subId),
        MMS_COPIED.map { k -> sval(o, k)?.let { clean(it, opts.nul) } ?: if (k in MMS_OMIT) null else "null" },
        writtenParts(m, opts).map { p -> PART_ATTRS.map { v(p, it) } },
        m.addrRows.map { r -> ADDR_ATTRS.map { v(r, it) } })
}

private class Counting(input: InputStream, private val onBytes: ((Long) -> Unit)?) : FilterInputStream(input) {
    var count = 0L
    override fun read(): Int {
        val b = super.read()
        if (b >= 0) bump(1)
        return b
    }

    override fun read(b: ByteArray, off: Int, len: Int): Int {
        val n = super.read(b, off, len)
        if (n > 0) bump(n)
        return n
    }

    private fun bump(n: Int) {
        count += n
        onBytes?.invoke(count)
    }
}

/** Re-reads a written SMS Backup & Restore file with a strict XML parser (the platform's
 *  SAX parser: Expat on Android) and compares every element, field by field and every
 *  attachment by SHA-256, with the source record it was written from, in order (msgs: the
 *  messages of this file). Also predicts the conversations Android will file the messages
 *  under after the restore. */
fun verify(input: InputStream, job: Job, msgs: List<Msg>, onBytes: ((Long) -> Unit)? = null,
           cancelled: () -> Boolean = { false }): Verification {
    val v = Verifier(job, msgs, cancelled)
    val stream = BufferedInputStream(Counting(input, onBytes), 1 shl 16)
    stream.mark(256)
    val head = ByteArray(200)
    var got = 0
    while (got < head.size) {
        val n = stream.read(head, got, head.size - got)
        if (n < 0) break
        got += n
    }
    stream.reset()
    if (!String(head, 0, got, Charsets.ISO_8859_1).startsWith("<?xml version='1.0' encoding='UTF-8'")) {
        v.errors.add("the file does not start with the XML declaration SMS Backup & Restore writes")
    }
    try {
        val factory = SAXParserFactory.newInstance()
        factory.isNamespaceAware = false
        factory.isValidating = false
        factory.newSAXParser().parse(InputSource(stream), v)
    } catch (e: SAXParseException) {
        v.errors.add("XML is not well-formed: line ${e.lineNumber}, column ${e.columnNumber}: ${e.message}")
    }
    return v.finish()
}

private class Verifier(private val job: Job, private val chosen: List<Msg>, private val cancelled: () -> Boolean) : DefaultHandler() {
    private val plan = job.plan
    private val opts = job.options
    private val sie = job.src.format == "sie"  // other formats have no thread_id
    val errors = ArrayList<String>()

    private var depth = 0
    private var rootName: String? = null
    private var rootCount: String? = null
    private var nSms = 0
    private var nMms = 0
    private var matchedSms = 0
    private var matchedMms = 0
    private val mismatched = ArrayList<Int>()
    private val badTags = LinkedHashMap<String, Int>()
    private var structure = 0
    private var attachments = 0
    private var badDates = 0
    private var badNames = 0
    private var mmsProblems = 0
    private val byThread = LinkedHashMap<String?, LinkedHashSet<List<String>>>()

    // the message element being read
    private var tag = ""
    private var attrs = HashMap<String, String>()
    private val kids = ArrayList<String>()
    private var container = ""
    private val parts = ArrayList<Pair<List<String?>, String?>>()  // attributes, data digest
    private val addrs = ArrayList<List<String?>>()
    private var nested = false

    private fun copy(a: Attributes): HashMap<String, String> {
        val out = HashMap<String, String>()
        for (i in 0 until a.length) out[a.getQName(i)] = a.getValue(i)
        return out
    }

    override fun startElement(uri: String?, localName: String?, qName: String, a: Attributes) {
        if (cancelled()) throw CancellationException()
        depth++
        when (depth) {
            1 -> {
                rootName = qName
                rootCount = a.getValue("count")
            }
            2 -> {
                tag = qName
                attrs = copy(a)
                kids.clear()
                parts.clear()
                addrs.clear()
                nested = false
            }
            3 -> {
                kids.add(qName)
                container = qName
            }
            4 -> when {
                container == "parts" && qName == "part" -> {
                    val data = a.getValue("data")?.let {
                        try {
                            digestOf(Base64.getDecoder().decode(it))
                        } catch (e: IllegalArgumentException) {
                            "invalid base64"
                        }
                    }
                    parts.add(PART_ATTRS.map { a.getValue(it) } to data)
                }
                container == "addrs" && qName == "addr" -> addrs.add(ADDR_ATTRS.map { a.getValue(it) })
                else -> nested = true
            }
            else -> nested = true
        }
    }

    override fun endElement(uri: String?, localName: String?, qName: String) {
        if (depth == 2) message()
        depth--
    }

    private fun message() {
        val index = nSms + nMms
        when (tag) {
            "sms" -> nSms++
            "mms" -> nMms++
            else -> {
                badTags[tag] = (badTags[tag] ?: 0) + 1
                return
            }
        }
        val m = chosen.getOrNull(index) ?: return
        var same = tag == m.kind && !nested
        if (same && m.isSms) {
            same = kids.isEmpty() && SMS_CHECKED.map { attrs[it] } == expectedSms(m, opts)
        } else if (same) {
            if (kids != listOf("parts", "addrs")) {
                structure++
                same = false
            } else {
                same = listOf(attrs["date"], attrs["sub_id"], MMS_COPIED.map { attrs[it] }, parts.map { it.first }, addrs) ==
                    expectedMms(m, opts)
                for ((i, p) in writtenParts(m, opts).withIndex()) {
                    if (!same) break
                    val name = partFile(p)
                    val want = if (name != null && name in job.src.names) job.conv.digests[name] else null
                    same = parts[i].second == want
                    if (same && want != null) attachments++
                }
            }
        }
        if (!same) {
            mismatched.add(m.line)
            return
        }
        if (m.isSms) matchedSms++ else matchedMms++
        val date = attrs["date"]
        if (isInt(date) && attrs["readable_date"] != readable(BigInteger(date), opts.tz)) badDates++
        if (attrs["contact_name"].isNullOrEmpty()) badNames++
        // Android files each restored message under the participant set in its address attribute.
        val address = attrs["address"] ?: ""
        val key: List<String>
        if (m.isSms) {
            key = listOf(addrKey(address))
        } else {
            val keys = address.split('~').map(::addrKey).toSet()
            key = keys.sorted()
            val own = plan.others(m).map(::addrKey)
            val hasOwner = keys.any { it in plan.owner }
            val hasOthers = keys.any { it !in plan.owner }
            if (!keys.containsAll(own) || (hasOwner && hasOthers)) mmsProblems++
        }
        byThread.getOrPut(sval(m.o, "thread_id")) { LinkedHashSet() }.add(key)
    }

    fun finish(): Verification {
        val total = nSms + nMms
        val expectSms = chosen.count { it.isSms }
        val expectMms = chosen.size - expectSms
        if (rootName != "smses") errors.add("root element is not <smses>")
        if (rootCount != total.toString()) errors.add("count=\"$rootCount\" but the file holds $total messages")
        if (total < chosen.size) errors.add("${chosen.size - total} message(s) are missing from the file")
        if (total > chosen.size) errors.add("${total - chosen.size} more message(s) in the file than were written")
        if (badTags.isNotEmpty()) errors.add("unexpected elements: " + badTags.entries.joinToString(", ") { it.key + " " + it.value })
        if (structure > 0) errors.add("$structure <mms> element(s) do not have exactly one <parts> and one <addrs>")
        if (mismatched.isNotEmpty()) {
            errors.add("${mismatched.size} message(s) do not match their source record exactly, e.g. source lines " +
                mismatched.take(5).joinToString(", "))
        }
        if (badDates > 0) errors.add("$badDates readable_date value(s) do not match their date")
        if (badNames > 0) errors.add("$badNames message(s) without contact_name")
        if (mmsProblems > 0) errors.add("$mmsProblems MMS have an address attribute that leaves out a participant or includes the owner")
        val owners = LinkedHashMap<List<String>, LinkedHashSet<String?>>()
        for ((t, keys) in byThread) for (k in keys) owners.getOrPut(k) { LinkedHashSet() }.add(t)
        fun show(k: List<String>) = if (k.size < 4) "[" + k.joinToString(", ") { mask(it) } + "]" else "[${k.size} people]"
        fun repr(t: String?) = if (t == null) "None" else "'$t'"
        val lines = arrayListOf(
            "VERIFICATION (the saved file re-read with a strict XML parser; every element compared field by",
            "              field with its source record)",
            "  well-formed XML:          " + if (errors.any { "well-formed" in it }) "no" else "yes",
            "  messages in file:         $nSms SMS + $nMms MMS = $total; root count=\"$rootCount\"",
            "  matched to source exactly: $matchedSms SMS of $expectSms, $matchedMms MMS of $expectMms" +
                if (opts.sample) " (test sample)" else "",
            "    compared: addresses, bodies/texts, dates (MMS seconds x 1000), type/msg_box, read,",
            "    seen, status, every MMS header, every part, every addr row",
            "  attachments checked:      $attachments (decoded back from the XML and compared by SHA-256)",
            "  conversations predicted after restore: ${owners.size}" +
                if (sie) " (from ${byThread.size} old thread_id values)" else "")
        val split = byThread.entries.filter { it.value.size > 1 && it.key != null }.sortedBy { it.key.toString() }
        for ((t, keys) in split) {
            lines.add("    old thread ${t ?: "None"} will appear as ${keys.size} conversations: " + keys.joinToString(" + ") { show(it) })
        }
        for ((k, ts) in if (sie) owners else emptyMap()) {
            if (ts.size > 1) {
                lines.add("    old threads [" + ts.sortedBy { it.toString() }.joinToString(", ") { repr(it) } +
                    "] will share one conversation [" + k.joinToString(", ") { mask(it) } + "]")
            }
        }
        lines.add("  result: " + if (errors.isEmpty()) "PASSED" else "FAILED")
        for (e in errors) lines.add("    ! $e")
        return Verification(errors.isEmpty(), errors, lines, owners.size, byThread.size,
            split.map { it.key to it.value.size })
    }
}
