/* Reading the backup formats other than SMS Import / Export's (which Engine.kt reads):
 * SMS Backup & Restore XML, Wonder, Pom and Buggy Backup. Each is turned into the same
 * records as an SMS Import / Export export (the columns of Android's message tables), with
 * the same rules as cli/sie_to_sbr.py and assets/converter.js. XML is read with the
 * platform's strict SAX parser (Expat on Android). */
package com.smsconverter.sie2sbr.core

import org.xml.sax.Attributes
import org.xml.sax.InputSource
import org.xml.sax.SAXException
import org.xml.sax.helpers.DefaultHandler
import java.io.File
import java.io.FilterInputStream
import java.io.InputStream
import java.math.BigInteger
import java.nio.ByteBuffer
import java.nio.charset.CharacterCodingException
import java.nio.charset.CodingErrorAction
import java.util.Base64
import java.util.Locale
import java.util.concurrent.CancellationException
import javax.xml.parsers.SAXParserFactory

/** A record built from columns, in order. */
fun objOf(map: Map<String, Any?>): JObj = JObj(map.keys.toTypedArray(), map.values.toTypedArray())

/** Attachments that a backup keeps inside its XML as base64 (SMS Backup & Restore, Pom):
 *  decoded into a temporary folder while reading, so a backup of several GB never has to
 *  fit in memory. Each one is named ATT_<n>, n counting in document order. */
class AttachmentStore(parent: File?) : java.io.Closeable {
    private val dir: File = File.createTempFile("sms-convert-", "", parent).also {
        it.delete()
        it.mkdirs()
    }
    val sizes = LinkedHashMap<String, Long>()
    private var count = 0

    /** Stores base64 text; returns its name. Text that is not valid base64 gets a name too,
     *  but no file, so the part is reported as an attachment missing from the backup. */
    fun add(text: String): String {
        count += 1
        val name = "ATT_$count"
        val b64 = if (text.any { it == ' ' || it == '\t' || it == '\r' || it == '\n' }) {
            text.filter { it != ' ' && it != '\t' && it != '\r' && it != '\n' }
        } else text
        if (validBase64(b64)) {
            val data = Base64.getDecoder().decode(b64)
            File(dir, name).writeBytes(data)
            sizes[name] = data.size.toLong()
        }
        return name
    }

    fun read(name: String): ByteArray = File(dir, name).readBytes()

    override fun close() {
        dir.deleteRecursively()
    }

    private fun validBase64(s: String): Boolean {
        if (s.length % 4 != 0) return false
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '+' || c == '/') i++ else break
        }
        val pad = s.length - i
        return pad <= 2 && (i until s.length).all { s[it] == '=' }
    }
}

private val SMS_SKIP = setOf("readable_date", "contact_name")
private val MMS_SKIP = setOf("address", "readable_date", "contact_name")
private val PART_SKIP = setOf("data", "_data_b64", "file")
private val PLMN = Regex("/TYPE=PLMN$", RegexOption.IGNORE_CASE)

private fun fromAttrs(a: Attributes, skip: Set<String> = emptySet()): LinkedHashMap<String, Any?> {
    val o = LinkedHashMap<String, Any?>()
    for (i in 0 until a.length) {
        val k = a.getQName(i)
        if (k !in skip) o[k] = a.getValue(i).let { if (it == "null") JNull else it }
    }
    return o
}

/** Turns the elements of an XML backup into records, as cli/sie_to_sbr.py's xml_records
 *  does: flavor "sbr", "wonder" or "pom"; emit(kind, record) in document order. */
private class XmlRecords(private val flavor: String, private val store: AttachmentStore,
                         private val cancelled: () -> Boolean, private val emit: (String, JObj) -> Unit) : DefaultHandler() {
    private var root: String? = null
    private var mms: LinkedHashMap<String, Any?>? = null
    private var parts = ArrayList<JObj>()
    private var rows = ArrayList<LinkedHashMap<String, Any?>>()
    private var recips = ArrayList<String>()

    override fun startElement(uri: String?, localName: String?, qName: String, a: Attributes) {
        if (cancelled()) throw CancellationException()
        if (root == null) {
            root = qName
            return
        }
        if (mms == null) {
            if (qName == "sms") {
                val o = fromAttrs(a, SMS_SKIP)
                if (a.getValue("body") == "null") o["body"] = "null"  // a text that says "null"
                val name = a.getValue("contact_name")
                if (name != null && name != "" && name != "null" && name != "(Unknown)") o["__display_name"] = name
                emit("sms", objOf(o))
            } else if (qName == "mms") {
                mms = fromAttrs(a, MMS_SKIP)
                parts = ArrayList()
                rows = ArrayList()
                recips = ArrayList()
            }
            return
        }
        when (qName) {
            "part" -> {
                val p = fromAttrs(a, PART_SKIP)
                if (a.getValue("seq") == null) p["seq"] = if (a.getValue("ct") == "application/smil") "-1" else "0"
                val b64 = a.getValue("_data_b64")
                val file = a.getValue("file")
                if (flavor == "sbr" && a.getValue("data") != null) p["_data"] = store.add(a.getValue("data"))
                else if (flavor == "pom" && b64 != null && b64 != "" && b64 != "null") p["_data"] = store.add(b64)
                else if (flavor == "wonder" && !file.isNullOrEmpty()) p["_data"] = file.replace('\\', '/').substringAfterLast('/')
                parts.add(objOf(p))
            }
            "addr" -> {
                val r = fromAttrs(a)
                val addr = r["address"]
                if (flavor == "pom" && addr is String && addr.isNotEmpty()) r["address"] = PLMN.replace(addr, "")
                rows.add(r)
            }
            "r" -> if (flavor == "pom" && !a.getValue("address").isNullOrEmpty()) recips.add(a.getValue("address"))
        }
    }

    override fun endElement(uri: String?, localName: String?, qName: String) {
        val o = mms
        if (qName != "mms" || o == null) return
        if (rows.isEmpty()) {
            for (x in recips) rows.add(linkedMapOf("address" to x, "type" to "151", "charset" to "106"))
        }
        val full = rows.mapIndexed { i, r ->
            if ("_id" in r) objOf(r) else objOf(LinkedHashMap<String, Any?>().also {
                it["_id"] = (i + 1).toString()
                it.putAll(r)
            })
        }
        val sender = full.firstOrNull { it["type"] == "137" }
        if (sender != null) o["__sender_address"] = sender
        o["__recipient_addresses"] = full.filter { it !== sender }
        o["__parts"] = parts
        emit("mms", objOf(o))
        mms = null
    }
}

private class Stop : SAXException("stop")

private fun saxParser() = SAXParserFactory.newInstance().apply {
    isNamespaceAware = false
    isValidating = false
}.newSAXParser()

/** Counts the bytes read, for progress, and stops when cancelled. */
private class ProgressInput(input: InputStream, private val start: Long, private val onBytes: ((Long) -> Unit)?,
                            private val cancelled: () -> Boolean) : FilterInputStream(input) {
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
        if (cancelled()) throw CancellationException()
        count += n
        onBytes?.invoke(start + count)
    }
}

/** The name of an XML document's root element, or null if it is not XML. */
fun xmlRoot(open: () -> InputStream): String? {
    var root: String? = null
    try {
        open().use {
            saxParser().parse(InputSource(it), object : DefaultHandler() {
                override fun startElement(uri: String?, localName: String?, qName: String, a: Attributes) {
                    root = qName
                    throw Stop()
                }
            })
        }
    } catch (e: Stop) {
        // found it
    } catch (e: Exception) {
        return null
    }
    return root
}

/** A backup kept in XML: SMS Backup & Restore (a .xml file, or one inside a ZIP), Wonder (a
 *  ZIP with one XML file and mms_attachments/) or Pom (a ZIP with sms.xml and mms.xml).
 *  members: one function per XML document that opens it. */
class XmlBackupSource(override val format: String, override val label: String, override val kind: String,
                      private val members: List<() -> InputStream>, private val zip: ZipArchive?, tempDir: File?,
                      override val loadSize: Long) : Source {
    private val store = AttachmentStore(tempDir)
    private val files = LinkedHashMap<String, String>()
    override var names: Set<String>
        private set

    init {
        if (format == "wonder" && zip != null) {
            for (n in zip.names) if (n.startsWith("mms_attachments/") && !n.endsWith("/")) files.putIfAbsent(n.substringAfterLast('/'), n)
        }
        names = files.keys.toSet()
    }

    override fun load(onBytes: ((Long) -> Unit)?, cancelled: () -> Boolean): Loaded {
        val msgs = ArrayList<Msg>()
        var record = 0
        var done = 0L
        for (member in members) {
            val handler = XmlRecords(format, store, cancelled) { kind, o -> msgs.add(Msg(++record, kind, o)) }
            member().use { input ->
                val counting = ProgressInput(input, done, onBytes, cancelled)
                try {
                    saxParser().parse(InputSource(counting), handler)
                } catch (e: CancellationException) {
                    throw e
                } catch (e: SAXException) {
                    throw SourceException("The backup's XML is damaged (" + e.message + ").")
                }
                done += counting.count
            }
        }
        if (format != "wonder") names = store.sizes.keys.toSet()
        return Loaded(msgs, emptyList(), 0)
    }

    override fun readPart(name: String): ByteArray = files[name]?.let { zip!!.read(it) } ?: store.read(name)

    override fun partSize(name: String): Long = files[name]?.let { zip!!.entries[it]!!.usize } ?: store.sizes[name]!!

    override fun close() = store.close()  // the ZIP archive belongs to the caller
}

private val BUGGY_ENTRY = Regex("conversations/conv_([0-9]+)")

/** A Buggy Backup ZIP: conversations/conv_<n>, each one SMS as JSON with one-letter keys
 *  (BUGGY_KEYS). It holds no MMS. */
class BuggySource(private val zip: ZipArchive, override val label: String) : Source {
    override val kind = "zip"
    override val format = "buggy"
    override val names: Set<String> = emptySet()
    private val entries = zip.names.mapNotNull { n -> BUGGY_ENTRY.matchEntire(n)?.let { BigInteger(it.groupValues[1]) to n } }
        .sortedWith(compareBy<Pair<BigInteger, String>> { it.first }.thenBy { it.second }).map { it.second }
    override val loadSize: Long = entries.sumOf { zip.entries[it]!!.usize }

    override fun load(onBytes: ((Long) -> Unit)?, cancelled: () -> Boolean): Loaded {
        val msgs = ArrayList<Msg>()
        val bad = ArrayList<Pair<Int, String>>()
        val decoder = Charsets.UTF_8.newDecoder()
            .onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT)
        val parser = JsonParser()
        var done = 0L
        for ((i, name) in entries.withIndex()) {
            if (cancelled()) throw CancellationException()
            val record = i + 1
            val bytes = zip.read(name)
            done += bytes.size
            onBytes?.invoke(done)
            val obj = try {
                parser.parse(decoder.decode(ByteBuffer.wrap(bytes)).toString())
            } catch (e: CharacterCodingException) {
                bad.add(record to "unreadable entry $name: the text is not valid UTF-8")
                continue
            } catch (e: JsonException) {
                bad.add(record to "unreadable entry $name: " + e.message)
                continue
            }
            if (obj !is JObj) {
                bad.add(record to "entry $name is not a JSON object")
                continue
            }
            val o = LinkedHashMap<String, Any?>()
            for ((key, col) in BUGGY_KEYS) if (obj.has(key)) o[col] = obj[key]
            val rec = objOf(o)
            if (classify(rec) != null) msgs.add(Msg(record, "sms", rec))
            else bad.add(record to "entry $name has neither an address nor a text")
        }
        return Loaded(msgs, bad, 0)
    }

    override fun readPart(name: String): ByteArray = throw NoSuchElementException(name)
    override fun partSize(name: String): Long = throw NoSuchElementException(name)
}

const val UNKNOWN_BACKUP = "This file is not a backup this converter knows. Choose a backup from a Fig or TAK phone " +
    "(SMS Import / Export), SMS Backup & Restore, Wonder, Pom or Buggy Backup."

/** Opens a backup in a ZIP archive, detecting its format from the contents (the same rules
 *  as cli/sie_to_sbr.py's open_source). tempDir: where attachments inside XML are unpacked. */
fun openBackupZip(zip: ZipArchive, label: String, tempDir: File? = null): Source {
    val names = zip.names
    if (names.any { it.substringAfterLast('/') == "messages.ndjson" }) return ZipSource(zip, label)
    if (names.any { BUGGY_ENTRY.matches(it) }) return BuggySource(zip, label)
    if (names.any { it == "sms.xml" || it == "mms.xml" || it == "_pom_backup_manifest.json" }) {
        val members = listOf("sms.xml", "mms.xml").filter { it in names }
        return XmlBackupSource("pom", label, "zip", members.map { n -> { zip.open(n) } }, zip, tempDir,
            members.sumOf { zip.entries[it]!!.usize })
    }
    val tops = names.filter { '/' !in it && it.lowercase(Locale.ROOT).endsWith(".xml") }
    if (tops.isNotEmpty()) {
        val top = tops[0]
        val format = when (xmlRoot { zip.open(top) }) {
            "smses" -> "sbr"
            "messages" -> "wonder"
            else -> null
        }
        if (format != null) return XmlBackupSource(format, label, "zip", listOf { zip.open(top) }, zip, tempDir, zip.entries[top]!!.usize)
    }
    throw SourceException("This ZIP file is not a backup this converter knows. Choose a backup from a Fig or TAK phone " +
        "(SMS Import / Export), SMS Backup & Restore, Wonder, Pom or Buggy Backup.")
}

/** Opens a backup that is a plain XML file (SMS Backup & Restore, or Wonder without its
 *  attachments). open() is called once to detect the format and once to read it. */
fun openBackupXml(open: () -> InputStream, label: String, size: Long, tempDir: File? = null): Source =
    when (xmlRoot(open)) {
        "smses" -> XmlBackupSource("sbr", label, "file", listOf(open), null, tempDir, size)
        "messages" -> XmlBackupSource("wonder", label, "file", listOf(open), null, tempDir, size)
        "calls" -> throw SourceException("This is a call log backup (calls-….xml), not a message backup.")
        else -> throw SourceException(UNKNOWN_BACKUP)
    }
