package com.smsconverter.sie2sbr.core

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import kotlin.system.exitProcess

/** Opens a backup on the desktop: an extracted SMS Import / Export folder, a ZIP file, or
 *  an XML file (SMS Backup & Restore), detecting the format from the contents. */
fun openSource(path: File, tempDir: File? = null): Source {
    if (path.isDirectory) {
        val files = path.walkTopDown().filter { it.isFile }.map { f ->
            SourceFile(f.relativeTo(path).invariantSeparatorsPath, f.length()) { f.inputStream() }
        }.toList()
        return FolderSource(files, path.name)
    }
    val raf = RandomAccessFile(path, "r")
    val zip = try {
        ZipArchive(RandomInput(raf.channel, raf))
    } catch (e: ZipException) {
        raf.close()
        return openBackupXml({ path.inputStream() }, path.name, path.length(), tempDir)
    }
    return openBackupZip(zip, path.name, tempDir)
}

/** The engine on the desktop, with the same arguments and output files as
 *  cli/sie_to_sbr.py and tests/run_js.mjs, so the three implementations can be compared:
 *
 *    convert SOURCE OUTPUT [--to sbr|fig|wonder] [--sample] [--keep all|sms|mms] [--no-groups]
 *            [--no-pdf] [--split-mb N] [--sub-id unknown|keep|N] [--tz ZONE]
 *            [--nul strip|replace] [--owner NUMBERS] */
fun main(argv: Array<String>) {
    var opts = Options()
    val pos = ArrayList<String>()
    var i = 0
    while (i < argv.size) {
        when (val a = argv[i]) {
            "--sample" -> opts = opts.copy(sample = true)
            "--to" -> opts = opts.copy(to = argv[++i])
            "--keep" -> opts = opts.copy(keep = argv[++i])
            "--no-groups" -> opts = opts.copy(noGroups = true)
            "--no-pdf" -> opts = opts.copy(noPdf = true)
            "--split-mb" -> opts = opts.copy(splitMb = argv[++i].toDouble())
            "--sub-id" -> opts = opts.copy(subId = argv[++i])
            "--tz" -> opts = opts.copy(tz = argv[++i])
            "--nul" -> opts = opts.copy(nul = argv[++i])
            "--owner" -> opts = opts.copy(owner = argv[++i])
            "--force" -> {}
            else -> pos.add(a)
        }
        i++
    }
    if (pos.size != 3 || pos[0] != "convert" || opts.to !in TARGETS) {
        System.err.println("usage: convert SOURCE OUTPUT [options]")
        exitProcess(2)
    }
    checkTimeZone(opts.tz)?.let {
        System.err.println("error: $it")
        exitProcess(2)
    }
    val output = File(pos[2])
    val src = openSource(File(pos[1]), output.absoluteFile.parentFile)
    var failed = false
    src.use {
        val job = prepare(src, load(src), opts)
        val ext = output.path.substring(output.path.lastIndexOf('.'))
        val stem = output.path.dropLast(ext.length)
        val files = ArrayList<WrittenFile>()
        for (k in job.parts.indices) {
            val file = File(if (job.parts.size == 1) output.path else "$stem-part${k + 1}$ext")
            val tmp = File(file.path + ".partial")
            val part = FileOutputStream(tmp).use { writePart(job, k, it) }
            tmp.renameTo(file)
            val verification = if (opts.to == "sbr") file.inputStream().use { verify(it, job, part.msgs) }
            else RandomAccessFile(file, "r").let { raf -> RandomInput(raf.channel, raf).use { verifyZip(it, job, part) } }
            File(file.path.dropLast(4) + ".manifest.csv").writeText(manifest(job, part.msgs))
            files.add(WrittenFile(file.name, part.bytes, verification))
            if (!verification.ok) failed = true
        }
        File("$stem.report.txt").writeText(report(job, files))
        println("wrote ${output.path}: ${job.chosen.size} messages in ${files.size} file(s); verification " +
            if (failed) "FAILED" else "PASSED")
        for (f in files) f.verification?.errors?.forEach { println("  ! $it") }
    }
    exitProcess(if (failed) 1 else 0)
}
