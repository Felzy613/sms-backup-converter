package com.smsconverter.sie2sbr

import android.content.Context
import android.net.Uri
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.OpenableColumns
import com.smsconverter.sie2sbr.core.FolderSource
import com.smsconverter.sie2sbr.core.RandomInput
import com.smsconverter.sie2sbr.core.Source
import com.smsconverter.sie2sbr.core.SourceFile
import com.smsconverter.sie2sbr.core.ZipArchive
import com.smsconverter.sie2sbr.core.ZipException
import com.smsconverter.sie2sbr.core.ZipSource
import java.io.Closeable
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException
import java.io.OutputStream
import java.io.RandomAccessFile
import java.io.SyncFailedException

/** Files the user picked with the system file picker (Storage Access Framework). The app
 *  has no storage permission: it can only touch what the user chose. */
object Saf {
    fun displayName(ctx: Context, uri: Uri): String? = try {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
            if (it.moveToFirst()) it.getString(0) else null
        }
    } catch (e: Exception) {
        null
    }

    /** Opens a picked ZIP file. A local file is read in place; anything that cannot be read at
     *  random positions is first copied into the app's cache (deleted again on close). */
    fun openZip(ctx: Context, uri: Uri, copyProgress: (Long, Long) -> Unit): Pair<Source, Closeable> {
        val label = displayName(ctx, uri) ?: "backup.zip"
        val cr = ctx.contentResolver
        val pfd = cr.openFileDescriptor(uri, "r") ?: throw IOException("Could not open $label.")
        val total = pfd.statSize
        if (total >= 0) {
            val fis = FileInputStream(pfd.fileDescriptor)
            val closer = Closeable {
                fis.close()
                pfd.close()
            }
            try {
                val zip = ZipArchive(RandomInput(fis.channel, closer))
                return ZipSource(zip, label) to zip
            } catch (e: IOException) {
                closer.close()
                if (e is ZipException) throw e  // not a ZIP file: copying would not help
            } catch (e: Exception) {
                closer.close()
                throw e
            }
        } else {
            pfd.close()
        }
        val tmp = File(ctx.cacheDir, "source.zip")
        (cr.openInputStream(uri) ?: throw IOException("Could not open $label.")).use { input ->
            tmp.outputStream().use { out ->
                val buf = ByteArray(1 shl 16)
                var done = 0L
                while (true) {
                    val n = input.read(buf)
                    if (n < 0) break
                    out.write(buf, 0, n)
                    done += n
                    copyProgress(done, total)
                }
            }
        }
        val raf = RandomAccessFile(tmp, "r")
        val zip = ZipArchive(RandomInput(raf.channel, Closeable {
            raf.close()
            tmp.delete()
        }))
        return ZipSource(zip, label) to zip
    }

    private class Child(val id: String, val name: String, val mime: String, val size: Long) {
        val isDir get() = mime == Document.MIME_TYPE_DIR
    }

    private fun children(ctx: Context, tree: Uri, docId: String): List<Child> {
        val uri = DocumentsContract.buildChildDocumentsUriUsingTree(tree, docId)
        val cols = arrayOf(Document.COLUMN_DOCUMENT_ID, Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE, Document.COLUMN_SIZE)
        val out = ArrayList<Child>()
        ctx.contentResolver.query(uri, cols, null, null, null)?.use { c ->
            while (c.moveToNext()) {
                out.add(Child(c.getString(0), c.getString(1) ?: "", c.getString(2) ?: "", if (c.isNull(3)) 0L else c.getLong(3)))
            }
        }
        return out
    }

    /** Opens a picked folder: the extracted export (messages.ndjson + data/), or a folder
     *  that holds it one level down. */
    fun openFolder(ctx: Context, tree: Uri): Source {
        val rootId = DocumentsContract.getTreeDocumentId(tree)
        val rootUri = DocumentsContract.buildDocumentUriUsingTree(tree, rootId)
        val label = displayName(ctx, rootUri) ?: "folder"
        var base = ""
        var top = children(ctx, tree, rootId)
        if (top.none { it.name == "messages.ndjson" && !it.isDir }) {
            for (d in top.filter { it.isDir }) {
                val kids = children(ctx, tree, d.id)
                if (kids.any { it.name == "messages.ndjson" && !it.isDir }) {
                    base = d.name + "/"
                    top = kids
                    break
                }
            }
        }
        fun file(path: String, c: Child) = SourceFile(path, c.size) {
            ctx.contentResolver.openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, c.id))
                ?: throw IOException("Could not open ${c.name}.")
        }
        val files = ArrayList<SourceFile>()
        for (c in top) {
            if (c.name == "messages.ndjson" && !c.isDir) files.add(file(base + c.name, c))
            if (c.name == "data" && c.isDir) {
                for (p in children(ctx, tree, c.id)) if (!p.isDir) files.add(file(base + "data/" + p.name, p))
            }
        }
        return FolderSource(files, label)
    }

    /** The folder the converted files are saved in. */
    class OutputFolder(private val ctx: Context, val tree: Uri) {
        private val cr = ctx.contentResolver
        private val dir = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))

        /** The folder's name. Some providers (Downloads on Android 8 and 9) report none for their
         *  top folder, so it is then derived from the folder's id, e.g. "primary:Download/SMS". */
        val name: String
            get() = displayName(ctx, dir) ?: DocumentsContract.getTreeDocumentId(tree).let { id ->
                when {
                    id == "downloads" -> "Downloads"
                    ':' in id -> id.substringAfter(':').ifEmpty { "Internal storage" }
                    else -> id
                }
            }

        /** True while the app may still write there (the folder exists and access was kept). */
        fun usable(): Boolean =
            cr.persistedUriPermissions.any { it.uri == tree && it.isWritePermission } && exists()

        /** Whether the folder can still be listed (it may have been deleted or its drive removed). */
        private fun exists(): Boolean = try {
            val children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree))
            cr.query(children, arrayOf(Document.COLUMN_DOCUMENT_ID), null, null, null)?.use { true } ?: false
        } catch (e: Exception) {
            false
        }

        fun create(name: String, mime: String): Uri =
            DocumentsContract.createDocument(cr, dir, mime, name) ?: throw IOException("Could not create $name in the chosen folder.")

        fun canRename(doc: Uri): Boolean = try {
            cr.query(doc, arrayOf(Document.COLUMN_FLAGS), null, null, null)?.use {
                it.moveToFirst() && it.getInt(0) and Document.FLAG_SUPPORTS_RENAME != 0
            } ?: false
        } catch (e: Exception) {
            false
        }

        fun rename(doc: Uri, name: String): Uri =
            DocumentsContract.renameDocument(cr, doc, name) ?: throw IOException("Could not rename the file to $name.")

        fun delete(doc: Uri) {
            try {
                DocumentsContract.deleteDocument(cr, doc)
            } catch (e: Exception) {
                // already gone, or the folder does not allow it; nothing more to do
            }
        }

        fun nameOf(doc: Uri): String? = displayName(ctx, doc)

        /** Writes doc and forces the data onto storage before returning. A plain stream can leave
         *  it in memory for a while, so a crash or flat battery right afterwards would leave an
         *  empty or cut-off file behind; this way a file that has its final name is complete. */
        fun <T> writeSynced(doc: Uri, block: (OutputStream) -> T): T {
            val pfd = cr.openFileDescriptor(doc, "w") ?: throw IOException("Could not write to the chosen folder.")
            return pfd.use {
                val out = FileOutputStream(it.fileDescriptor)
                val result = block(out)
                out.flush()
                try {
                    it.fileDescriptor.sync()
                } catch (e: SyncFailedException) {
                    // a pipe from a non-local storage provider: there is nothing to sync here
                }
                result
            }
        }

        fun write(name: String, mime: String, text: String): String {
            val doc = create(name, mime)
            writeSynced(doc) { it.write(text.toByteArray()) }
            return nameOf(doc) ?: name
        }
    }
}
