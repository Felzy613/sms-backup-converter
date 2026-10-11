import java.util.zip.ZipFile
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.smsconverter.sie2sbr"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.smsconverter.sie2sbr"
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"))
            // Signed with the local debug key so the APK can be installed directly. Use your
            // own release key instead if the app is ever published.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += listOf("kotlin/**", "kotlin-tooling-metadata.json", "META-INF/*.version", "META-INF/*.kotlin_module")
    }

    // No Google Play dependency-metadata block inside the APK.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    // Nothing else: no AndroidX, no Google libraries, no analytics. Only the engine.
    implementation(project(":core"))
}

// Fails the build if the APK could reach the internet, browse, or install apps: it must
// request no permissions at all, declare no <queries>, and its code must not reference
// WebView, the package installer, URL-opening intents or network classes.
val kosherCheck = tasks.register("kosherCheck") {
    group = "verification"
    description = "Checks that the release APK has no network, browsing or app-install capability."
    dependsOn("assembleRelease")
    doLast {
        val apk = layout.buildDirectory.dir("outputs/apk/release").get().asFile
            .listFiles { f -> f.name.endsWith(".apk") }!!.single()
        val forbiddenInCode = listOf(
            "Landroid/webkit/", "Landroid/net/http", "Landroid/content/pm/PackageInstaller",
            "Ljava/net/URL;", "Ljava/net/URLConnection;", "Ljava/net/HttpURLConnection;", "Ljava/net/Socket;",
            "Ljavax/net/", "Landroid/net/ConnectivityManager;", "Landroid/app/DownloadManager;",
            "android.intent.action.VIEW", "android.intent.action.WEB_SEARCH", "android.intent.action.INSTALL_PACKAGE",
            "android.intent.action.SEND", "application/vnd.android.package-archive", "http://", "https://",
        )
        fun ByteArray.has(s: String, utf16: Boolean): Boolean {
            val needle = if (utf16) s.toByteArray(Charsets.UTF_16LE) else s.toByteArray(Charsets.UTF_8)
            outer@ for (i in 0..size - needle.size) {
                for (j in needle.indices) if (this[i + j] != needle[j]) continue@outer
                return true
            }
            return false
        }
        val problems = mutableListOf<String>()
        ZipFile(apk).use { zip ->
            for (e in zip.entries()) {
                val bytes = zip.getInputStream(e).readBytes()
                if (e.name == "AndroidManifest.xml") {
                    for (s in listOf("android.permission.", "queries", "REQUEST_INSTALL")) {
                        if (bytes.has(s, false) || bytes.has(s, true)) problems.add("AndroidManifest.xml mentions \"$s\"")
                    }
                } else if (e.name.endsWith(".dex")) {
                    for (s in forbiddenInCode) if (bytes.has(s, false)) problems.add("${e.name} references \"$s\"")
                }
            }
        }
        if (problems.isNotEmpty()) throw GradleException("Kosher check failed for ${apk.name}:\n  " + problems.joinToString("\n  "))
        println("Kosher check passed: ${apk.name} requests no permissions and has no network, browser or install code.")
    }
}
