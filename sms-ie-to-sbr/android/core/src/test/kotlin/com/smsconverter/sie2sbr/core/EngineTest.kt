package com.smsconverter.sie2sbr.core

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.RandomAccessFile
import java.math.BigInteger
import java.util.zip.CRC32
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

class EngineTest {
    private val ndjson = listOf(
        """{"_id":"1","thread_id":"7","address":"+1 (555) 123-4567","date":"1700000000000","type":"1","body":"Hi & <bye>\n\u0000x","read":"1","status":"-1","sub_id":"2","__display_name":"Ann"}""",
        """{"_id":"2","thread_id":"7","address":"5551234567","date":"1700000100000","type":"2","body":"ok 😀","read":"1","status":"0","sub_id":"2"}""",
        "",
        """{"_id":"3","thread_id":"7","date":"1700000200","msg_box":"1","m_type":"132","sub_id":"2","__sender_address":{"_id":"10","address":"5551234567","type":"137","charset":"106","__display_name":"Ann"},"__recipient_addresses":[{"_id":"11","address":"+15559998888","type":"151","charset":"106"}],"__parts":[{"seq":"0","ct":"image/jpeg","_data":"/data/user/0/com.android.providers.telephony/app_parts/PART_1"},{"seq":"0","ct":"text/plain","text":"pic"}]}""",
        """{"_id":"4","thread_id":"7","date":"1700000300","msg_box":"2","m_type":"128","__sender_address":{"_id":"12","address":"+15559998888","type":"137","charset":"106"},"__recipient_addresses":[{"_id":"13","address":"5551234567","type":"151","charset":"106"}],"__parts":[{"seq":"0","ct":"text/plain","text":"sent"}]}""",
        "not json",
        """{"_id":"5","thread_id":"8","date":"1700000400000","type":"1","body":"no address"}""",
    ).joinToString("\n") + "\n"
    private val jpeg = ByteArray(5000) { (it * 31).toByte() }

    private fun folder(): Source = FolderSource(listOf(
        SourceFile("export/messages.ndjson", ndjson.length.toLong()) { ByteArrayInputStream(ndjson.toByteArray()) },
        SourceFile("export/data/PART_1", jpeg.size.toLong()) { ByteArrayInputStream(jpeg) },
    ), "export")

    private fun run(src: Source, opts: Options = Options(tz = "UTC")): Pair<Result, ByteArray> {
        val loaded = load(src)
        val out = ByteArrayOutputStream()
        val result = convert(src, loaded, Plan(loaded.msgs, opts.owner), opts, out)
        return result to out.toByteArray()
    }

    @Test
    fun convertsAndVerifies() {
        val (result, xml) = run(folder())
        val text = String(xml, Charsets.UTF_8)
        assertEquals(4, result.chosen.size)
        assertEquals(listOf(6), result.loaded.bad.map { it.first })
        assertEquals(1, result.problems.size)  // the SMS without an address
        assertEquals(setOf("5559998888"), result.plan.owner)
        assertTrue("body=\"Hi &amp; &lt;bye&gt;&#10;x\"" in text, text)
        assertTrue("readable_date=\"Nov 14, 2023 10:13:20 PM\"" in text)
        assertTrue("contact_name=\"Ann\"" in text)
        assertTrue("date=\"1700000200000\"" in text)  // MMS seconds -> milliseconds
        assertTrue("data=\"" + java.util.Base64.getEncoder().encodeToString(jpeg) + "\"" in text)
        assertEquals(1, result.conv.changes.size)  // the U+0000
        val v = verify(ByteArrayInputStream(xml), result)
        assertTrue(v.ok, v.lines.joinToString("\n"))
        assertEquals(1, v.conversations)
        assertTrue(report(result, "x.xml", v).contains("result: PASSED"))
        assertTrue(manifest(result).startsWith("xml_index,kind,direction"))
    }

    @Test
    fun verificationCatchesChanges() {
        val (result, xml) = run(folder())
        val text = String(xml, Charsets.UTF_8)
        fun check(changed: String) = verify(ByteArrayInputStream(changed.toByteArray()), result)
        assertFalse(check(text.replace("ok 😀", "ok")).ok)                    // a body
        assertFalse(check(text.replace("data=\"AB", "data=\"AC")).ok)         // an attachment byte
        assertFalse(check(text.replace("<smses count=\"4\"", "<smses count=\"5\"")).ok)
        assertFalse(check(text.substring(0, text.length - 20)).ok)           // truncated
        assertFalse(check(text.replace("</parts>", "</parts><x/>")).ok)
    }

    @Test
    fun sampleOptionsAndOwner() {
        val (result, _) = run(folder(), Options(tz = "UTC", sample = true, subId = "keep", owner = "555 123 4567"))
        assertEquals(setOf("5551234567"), result.plan.owner)
        assertTrue(result.chosen.isNotEmpty())
    }

    /** A ZIP written the way Android writes it: deflated entries with data descriptors. */
    private fun zipFile(stored: Boolean = false): File {
        val f = File.createTempFile("export", ".zip")
        f.deleteOnExit()
        ZipOutputStream(f.outputStream()).use { z ->
            z.putNextEntry(ZipEntry("messages.ndjson"))
            z.write(ndjson.toByteArray())
            z.closeEntry()
            val e = ZipEntry("data/PART_1")
            if (stored) {
                e.method = ZipEntry.STORED
                e.size = jpeg.size.toLong()
                e.crc = CRC32().apply { update(jpeg) }.value
            }
            z.putNextEntry(e)
            z.write(jpeg)
            z.closeEntry()
            z.putNextEntry(ZipEntry("data/"))
            z.closeEntry()
        }
        return f
    }

    private fun openZip(f: File): Source {
        val raf = RandomAccessFile(f, "r")
        return ZipSource(ZipArchive(RandomInput(raf.channel, raf)), f.name)
    }

    @Test
    fun zipMatchesFolder() {
        for (stored in listOf(false, true)) {
            val (_, fromFolder) = run(folder())
            val (result, fromZip) = run(openZip(zipFile(stored)))
            fun body(b: ByteArray) = String(b, Charsets.UTF_8).lines().filterIndexed { i, _ -> i != 1 && i != 3 }
            assertEquals(body(fromFolder), body(fromZip))
            assertEquals(setOf("PART_1"), result.src.names)
        }
    }

    @Test
    fun damagedZipIsRejected() {
        val f = zipFile()
        val bytes = f.readBytes()
        val at = String(bytes, Charsets.ISO_8859_1).indexOf("data/PART_1") + 11 + 100  // inside the compressed data
        bytes[at] = (bytes[at].toInt() xor 0xFF).toByte()
        f.writeBytes(bytes)
        assertFailsWith<Exception> { openZip(f).readPart("PART_1") }
        val notZip = File.createTempFile("notzip", ".zip").apply { writeText("hello, this is not a zip file at all") }
        assertFailsWith<ZipException> { openZip(notZip) }
    }

    @Test
    fun json() {
        val p = JsonParser()
        val o = p.parse("""{"a":"x","a":"y","n":12345678901234567890,"f":1.50,"t":true,"z":null,"u":"\ud83d\ude00\u00e9"}""") as JObj
        assertEquals(listOf("a", "n", "f", "t", "z", "u"), o.keyList)
        assertEquals("y", sval(o, "a"))
        assertEquals("12345678901234567890", sval(o, "n"))
        assertEquals("1.5", sval(o, "f"))
        assertEquals("1", sval(o, "t"))
        assertNull(sval(o, "z"))
        assertTrue(o.has("z"))
        assertEquals("😀é", sval(o, "u"))
        for (bad in listOf("{", "{\"a\":01}", "[1,]", "\"a\u0001\"", "\uFEFF{}", "{} x", "nul", "1.", "\"\\x\"")) {
            assertFailsWith<JsonException>(bad) { p.parse(bad) }
        }
    }

    @Test
    fun helpers() {
        assertEquals("5551234567", addrKey(" +1 (555) 123-4567 "))
        assertEquals("multi:5551234567,5559998888", addrKey("5559998888 555-123-4567"))
        assertEquals("abc@x.com", addrKey("ABC@x.com"))
        assertEquals("…4567", mask("5551234567"))
        assertEquals("Sep 30, 2010 8:34:28 AM", readable(BigInteger("1285850068000"), "America/New_York"))
        assertEquals("Jan 1, 1970 12:00:00 AM", readable(BigInteger("999"), "UTC"))
        assertEquals("Dec 31, 1969 11:59:59 PM", readable(BigInteger("-1"), "UTC"))
        assertNull(readable(BigInteger("9".repeat(30)), "UTC"))
        assertEquals("a\uFFFDb", clean("a\u0000b", "replace"))
        assertEquals("ab😀", clean("a\uD800b😀", "strip"))
        assertEquals("&amp;&lt;&gt;&quot;&#10;&#13;&#9;", esc("&<>\"\n\r\t"))
        assertNull(checkTimeZone("Europe/London"))
        assertTrue(checkTimeZone("Not/AZone") != null)
    }
}
