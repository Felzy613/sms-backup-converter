package com.smsconverter.sie2sbr.core

import java.io.Closeable
import java.io.EOFException
import java.io.IOException
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.channels.FileChannel
import java.util.zip.CRC32
import java.util.zip.DataFormatException
import java.util.zip.Inflater

/** Positional reads from a file (a FileChannel on the desktop and on Android). */
class RandomInput(private val channel: FileChannel, private val owner: Closeable? = null) : Closeable {
    val size: Long = channel.size()

    /** Up to len bytes at pos; fewer only at the end of the file. */
    fun read(pos: Long, len: Int): ByteArray {
        val n = maxOf(0L, minOf(len.toLong(), size - pos)).toInt()
        val buf = ByteBuffer.allocate(n)
        var p = pos
        while (buf.hasRemaining()) {
            val got = channel.read(buf, p)
            if (got < 0) throw EOFException("The file ended early.")
            p += got
        }
        return buf.array()
    }

    override fun close() {
        channel.close()
        owner?.close()
    }
}

class ZipException(message: String) : IOException(message)

/** Minimal read-only ZIP reader, a port of assets/zip.js: reads the central directory (so
 *  entries written with data descriptors, as Android's ZipOutputStream does, work),
 *  supports stored and deflated entries and ZIP64, checks every entry's size and CRC-32,
 *  and reads entries on demand, so a large archive never has to fit in memory. */
class ZipArchive(private val input: RandomInput) : Closeable {
    class Entry(val name: String, val flags: Int, val method: Int, val crc: Long,
                val csize: Long, val usize: Long, val offset: Long)

    val entries = LinkedHashMap<String, Entry>()
    val names = ArrayList<String>()

    init {
        val size = input.size
        if (size < 22) throw ZipException(NOT_ZIP)
        val tailStart = maxOf(0L, size - (22 + 0xFFFF))
        val tail = input.read(tailStart, (size - tailStart).toInt())
        var at = -1
        for (i in tail.size - 22 downTo 0) {
            if (u32(tail, i) == SIG_EOCD && i + 22 + u16(tail, i + 20) <= tail.size) {
                at = i
                break
            }
        }
        if (at < 0) throw ZipException(NOT_ZIP)
        val eocd = tailStart + at
        var count = u16(tail, at + 10).toLong()
        var cdSize = u32(tail, at + 12)
        var cdOffset = u32(tail, at + 16)
        var zip64 = false
        if (eocd >= 20) {
            val loc = input.read(eocd - 20, 20)
            if (u32(loc, 0) == SIG_ZIP64_LOCATOR) {
                val recAt = u64(loc, 8)
                val rec = if (recAt in 0 until size) input.read(recAt, 56) else ByteArray(0)
                if (rec.size < 56 || u32(rec, 0) != SIG_ZIP64_EOCD) {
                    throw ZipException("This ZIP archive is damaged (bad ZIP64 end record).")
                }
                count = u64(rec, 32)
                cdSize = u64(rec, 40)
                cdOffset = u64(rec, 48)
                zip64 = true
            }
        }
        // Bytes prepended to the archive (self-extractors) shift every offset; Python does the same.
        val shift = eocd - cdSize - cdOffset - (if (zip64) 76 else 0)
        if (cdOffset + shift < 0 || cdSize > Int.MAX_VALUE || cdOffset + shift + cdSize > size) {
            throw ZipException("This ZIP archive is damaged (bad central directory).")
        }
        val cd = input.read(cdOffset + shift, cdSize.toInt())
        var p = 0
        for (n in 0 until count) {
            if (p + 46 > cd.size || u32(cd, p) != SIG_CENTRAL) {
                throw ZipException("This ZIP archive is damaged (bad central directory).")
            }
            val flags = u16(cd, p + 8)
            val method = u16(cd, p + 10)
            val crc = u32(cd, p + 16)
            var csize = u32(cd, p + 20)
            var usize = u32(cd, p + 24)
            val nameLen = u16(cd, p + 28)
            val extraLen = u16(cd, p + 30)
            val commentLen = u16(cd, p + 32)
            var offset = u32(cd, p + 42)
            if (p + 46 + nameLen + extraLen > cd.size) {
                throw ZipException("This ZIP archive is damaged (bad central directory).")
            }
            val raw = cd.copyOfRange(p + 46, p + 46 + nameLen)
            val name = if (flags and 0x800 != 0) String(raw, Charsets.UTF_8) else cp437(raw)
            var e = p + 46 + nameLen
            val end = e + extraLen
            while (e + 4 <= end) {
                val id = u16(cd, e)
                val len = u16(cd, e + 2)
                if (id == 0x0001) {  // ZIP64 extended information
                    var q = e + 4
                    if (usize == 0xFFFFFFFFL) { usize = u64(cd, q); q += 8 }
                    if (csize == 0xFFFFFFFFL) { csize = u64(cd, q); q += 8 }
                    if (offset == 0xFFFFFFFFL) { offset = u64(cd, q); q += 8 }
                }
                e += 4 + len
            }
            entries[name] = Entry(name, flags, method, crc, csize, usize, offset + shift)
            names.add(name)
            p = end + commentLen
        }
    }

    /** A stream of the entry's uncompressed bytes. It throws when the entry turns out to be
     *  damaged (wrong size or CRC-32), at the latest on reaching its end. */
    fun open(name: String): InputStream {
        val en = entries[name] ?: throw ZipException("\"$name\" is not in the ZIP archive.")
        if (en.flags and 1 != 0) throw ZipException("\"$name\" is encrypted; the archive must not have a password.")
        val head = input.read(en.offset, 30)
        if (head.size < 30 || u32(head, 0) != SIG_LOCAL) throw ZipException("This ZIP archive is damaged (\"$name\").")
        val start = en.offset + 30 + u16(head, 26) + u16(head, 28)
        if (en.method != 0 && en.method != 8) {
            throw ZipException("\"$name\" uses an unsupported compression method (${en.method}).")
        }
        return EntryStream(en, start)
    }

    fun read(name: String): ByteArray = open(name).use { it.readBytes() }

    override fun close() = input.close()

    private inner class EntryStream(private val en: Entry, start: Long) : InputStream() {
        private var pos = start
        private val end = start + en.csize
        private val inflater = if (en.method == 8) Inflater(true) else null
        private var dummySent = false
        private val crc = CRC32()
        private var count = 0L
        private var done = false

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else one[0].toInt() and 0xFF
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int {
            if (len == 0) return 0
            if (done) return -1
            val n = if (inflater == null) readStored(b, off, len) else readDeflated(b, off, len)
            if (n < 0) {
                finish()
                return -1
            }
            crc.update(b, off, n)
            count += n
            return n
        }

        private fun readStored(b: ByteArray, off: Int, len: Int): Int {
            if (pos >= end) return -1
            val chunk = input.read(pos, minOf(len.toLong(), end - pos).toInt())
            if (chunk.isEmpty()) throw damaged()
            System.arraycopy(chunk, 0, b, off, chunk.size)
            pos += chunk.size
            return chunk.size
        }

        private fun readDeflated(b: ByteArray, off: Int, len: Int): Int {
            val inf = inflater!!
            while (true) {
                val n = try {
                    inf.inflate(b, off, len)
                } catch (e: DataFormatException) {
                    throw damaged()
                }
                if (n > 0) return n
                if (inf.finished() || (en.csize == 0L && pos >= end)) return -1
                if (inf.needsDictionary()) throw damaged()
                if (inf.needsInput()) {
                    if (pos < end) {
                        val chunk = input.read(pos, minOf(65536L, end - pos).toInt())
                        if (chunk.isEmpty()) throw damaged()
                        pos += chunk.size
                        inf.setInput(chunk)
                    } else if (!dummySent) {
                        // zlib may want one byte past the raw deflate data (see java.util.zip.Inflater)
                        dummySent = true
                        inf.setInput(ByteArray(1))
                    } else {
                        throw damaged()
                    }
                }
            }
        }

        private fun finish() {
            if (done) return
            done = true
            inflater?.end()
            if (count != en.usize || crc.value != en.crc) throw damaged()
        }

        private fun damaged() = ZipException("\"${en.name}\" is damaged inside the ZIP archive (size or CRC-32 mismatch).")

        override fun close() {
            if (!done) {
                done = true
                inflater?.end()
            }
        }
    }

    companion object {
        private const val NOT_ZIP = "This file is not a ZIP archive. Choose the messages-YYYY-MM-DD.zip that " +
            "SMS Import / Export created."
        private const val SIG_EOCD = 0x06054b50L
        private const val SIG_ZIP64_LOCATOR = 0x07064b50L
        private const val SIG_ZIP64_EOCD = 0x06064b50L
        private const val SIG_CENTRAL = 0x02014b50L
        private const val SIG_LOCAL = 0x04034b50L

        // Names without the UTF-8 flag are CP437, as in Python's zipfile.
        private const val CP437_HIGH = "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
            "└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ "

        fun cp437(bytes: ByteArray): String {
            val b = StringBuilder(bytes.size)
            for (x in bytes) {
                val v = x.toInt() and 0xFF
                b.append(if (v < 0x80) v.toChar() else CP437_HIGH[v - 0x80])
            }
            return b.toString()
        }

        private fun u16(b: ByteArray, i: Int) = (b[i].toInt() and 0xFF) or ((b[i + 1].toInt() and 0xFF) shl 8)
        private fun u32(b: ByteArray, i: Int) = (u16(b, i).toLong()) or (u16(b, i + 2).toLong() shl 16)
        private fun u64(b: ByteArray, i: Int): Long {
            val v = u32(b, i) or (u32(b, i + 4) shl 32)
            if (v < 0) throw ZipException("This ZIP archive is damaged (size out of range).")
            return v
        }
    }
}
