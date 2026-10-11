package com.smsconverter.sie2sbr.core

import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import kotlin.system.exitProcess

/** Opens an export on the desktop: a ZIP file or an extracted folder. */
fun openSource(path: File): Source {
    if (path.isDirectory) {
        val files = path.walkTopDown().filter { it.isFile }.map { f ->
            SourceFile(f.relativeTo(path).invariantSeparatorsPath, f.length()) { f.inputStream() }
        }.toList()
        return FolderSource(files, path.name)
    }
    val raf = RandomAccessFile(path, "r")
    return ZipSource(ZipArchive(RandomInput(raf.channel, raf)), path.name)
}

/** The engine on the desktop, with the same arguments and output files as tests/run_js.mjs,
 *  so the three implementations can be compared:
 *
 *    convert SOURCE OUTPUT.xml [--sample] [--sub-id unknown|keep|N] [--tz ZONE]
 *            [--nul strip|replace] [--owner NUMBERS] */
fun main(argv: Array<String>) {
    var opts = Options()
    val pos = ArrayList<String>()
    var i = 0
    while (i < argv.size) {
        when (val a = argv[i]) {
            "--sample" -> opts = opts.copy(sample = true)
            "--sub-id" -> opts = opts.copy(subId = argv[++i])
            "--tz" -> opts = opts.copy(tz = argv[++i])
            "--nul" -> opts = opts.copy(nul = argv[++i])
            "--owner" -> opts = opts.copy(owner = argv[++i])
            else -> pos.add(a)
        }
        i++
    }
    if (pos.size != 3 || pos[0] != "convert") {
        System.err.println("usage: convert SOURCE OUTPUT.xml [options]")
        exitProcess(2)
    }
    checkTimeZone(opts.tz)?.let {
        System.err.println("error: $it")
        exitProcess(2)
    }
    val output = File(pos[2])
    val src = openSource(File(pos[1]))
    val loaded = load(src)
    val plan = Plan(loaded.msgs, opts.owner)
    val tmp = File(output.path + ".partial")
    val result = FileOutputStream(tmp).use { convert(src, loaded, plan, opts, it) }
    tmp.renameTo(output)
    val verification = output.inputStream().use { verify(it, result) }
    val base = output.path.dropLast(4)
    File("$base.manifest.csv").writeText(manifest(result))
    File("$base.report.txt").writeText(report(result, output.name, verification))
    println("wrote ${output.path}: ${result.chosen.size} messages; verification " + if (verification.ok) "PASSED" else "FAILED")
    verification.errors.forEach { println("  ! $it") }
    exitProcess(if (verification.ok) 0 else 1)
}
