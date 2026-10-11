package com.smsconverter.sie2sbr.core

import java.math.BigDecimal
import java.math.BigInteger

/** JSON null, kept apart from "no such key" (which is Kotlin null). */
object JNull

/** A JSON number as written in the source. */
class JNum(val text: String) {
    /** How String(n) in the browser version / str(n) in the Python version prints it:
     *  integers exactly, other numbers in plain decimal notation. */
    val asString: String by lazy(LazyThreadSafetyMode.NONE) {
        if (text.none { it == '.' || it == 'e' || it == 'E' }) BigInteger(text).toString()
        else BigDecimal(text).stripTrailingZeros().toPlainString()
    }

    override fun toString() = asString
}

/** A JSON object with its keys in document order. Kept compact because an export holds
 *  tens of thousands of them: keys are interned and looked up linearly (records have ~15). */
class JObj(private val keys: Array<String>, private val values: Array<Any?>) {
    val keyList: List<String> get() = keys.asList()

    fun has(key: String) = indexOf(key) >= 0

    /** The value (JNull for JSON null), or null when the key is not present. */
    operator fun get(key: String): Any? {
        val i = indexOf(key)
        return if (i < 0) null else values[i]
    }

    private fun indexOf(key: String): Int {
        for (i in keys.indices) if (keys[i] == key) return i
        return -1
    }
}

class JsonException(message: String) : Exception(message)

/** A strict JSON (RFC 8259) parser: objects -> JObj, arrays -> List, strings -> String,
 *  numbers -> JNum, true/false -> Boolean, null -> JNull. A repeated key keeps its first
 *  position and its last value, as JSON.parse and Python's json module do. */
class JsonParser(private val pool: HashMap<String, String> = HashMap()) {
    private var s = ""
    private var i = 0

    fun parse(text: String): Any? {
        s = text
        i = 0
        ws()
        val v = value()
        ws()
        if (i != s.length) fail("unexpected data after the JSON value")
        return v
    }

    private fun fail(what: String): Nothing = throw JsonException("$what at column ${i + 1}")

    private fun ws() {
        while (i < s.length) {
            val c = s[i]
            if (c == ' ' || c == '\t' || c == '\n' || c == '\r') i++ else return
        }
    }

    private fun value(): Any? {
        if (i >= s.length) fail("unexpected end of data")
        return when (val c = s[i]) {
            '{' -> obj()
            '[' -> arr()
            '"' -> str()
            't' -> literal("true", true)
            'f' -> literal("false", false)
            'n' -> literal("null", JNull)
            else -> if (c == '-' || c in '0'..'9') num() else fail("unexpected character '$c'")
        }
    }

    private fun literal(word: String, v: Any): Any {
        if (!s.startsWith(word, i)) fail("invalid literal")
        i += word.length
        return v
    }

    private fun obj(): JObj {
        i++
        val keys = ArrayList<String>()
        val values = ArrayList<Any?>()
        ws()
        if (i < s.length && s[i] == '}') {
            i++
            return JObj(emptyArray(), emptyArray())
        }
        while (true) {
            ws()
            if (i >= s.length || s[i] != '"') fail("expected a property name")
            val raw = str()
            val key = pool.getOrPut(raw) { raw }
            ws()
            if (i >= s.length || s[i] != ':') fail("expected ':'")
            i++
            ws()
            val v = value()
            val at = keys.indexOf(key)
            if (at >= 0) values[at] = v else {
                keys.add(key)
                values.add(v)
            }
            ws()
            if (i >= s.length) fail("unterminated object")
            when (s[i]) {
                ',' -> i++
                '}' -> {
                    i++
                    return JObj(keys.toTypedArray(), values.toTypedArray())
                }
                else -> fail("expected ',' or '}'")
            }
        }
    }

    private fun arr(): List<Any?> {
        i++
        val out = ArrayList<Any?>()
        ws()
        if (i < s.length && s[i] == ']') {
            i++
            return out
        }
        while (true) {
            ws()
            out.add(value())
            ws()
            if (i >= s.length) fail("unterminated array")
            when (s[i]) {
                ',' -> i++
                ']' -> {
                    i++
                    return out
                }
                else -> fail("expected ',' or ']'")
            }
        }
    }

    private fun str(): String {
        i++
        val start = i
        while (i < s.length) {  // fast path: no escapes
            val c = s[i]
            if (c == '"') return s.substring(start, i++)
            if (c == '\\') break
            if (c < ' ') fail("control character in string")
            i++
        }
        val b = StringBuilder().append(s, start, i)
        while (true) {
            if (i >= s.length) fail("unterminated string")
            val c = s[i++]
            when {
                c == '"' -> return b.toString()
                c < ' ' -> {
                    i--
                    fail("control character in string")
                }
                c != '\\' -> b.append(c)
                else -> {
                    if (i >= s.length) fail("unterminated string")
                    when (val e = s[i++]) {
                        '"', '\\', '/' -> b.append(e)
                        'b' -> b.append('\b')
                        'f' -> b.append('\u000C')
                        'n' -> b.append('\n')
                        'r' -> b.append('\r')
                        't' -> b.append('\t')
                        'u' -> {
                            if (i + 4 > s.length) fail("invalid \\u escape")
                            var v = 0
                            for (k in 0 until 4) {
                                val d = Character.digit(s[i + k], 16)
                                if (d < 0 || s[i + k] > 'f') fail("invalid \\u escape")
                                v = v * 16 + d
                            }
                            i += 4
                            b.append(v.toChar())
                        }
                        else -> {
                            i--
                            fail("invalid escape")
                        }
                    }
                }
            }
        }
    }

    private fun num(): JNum {
        val start = i
        if (s[i] == '-') i++
        if (i < s.length && s[i] == '0') i++
        else if (i < s.length && s[i] in '1'..'9') while (i < s.length && s[i] in '0'..'9') i++
        else fail("invalid number")
        if (i < s.length && s[i] == '.') {
            i++
            if (i >= s.length || s[i] !in '0'..'9') fail("invalid number")
            while (i < s.length && s[i] in '0'..'9') i++
        }
        if (i < s.length && (s[i] == 'e' || s[i] == 'E')) {
            i++
            if (i < s.length && (s[i] == '+' || s[i] == '-')) i++
            if (i >= s.length || s[i] !in '0'..'9') fail("invalid number")
            while (i < s.length && s[i] in '0'..'9') i++
        }
        return JNum(s.substring(start, i))
    }
}
