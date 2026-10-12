import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// The conversion engine: plain Kotlin/JVM with no Android or third-party dependencies,
// shared by the app and by the desktop command line used to compare it with the
// Python and browser versions.
plugins {
    id("org.jetbrains.kotlin.jvm")
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    testImplementation(kotlin("test"))
}

tasks.test {
    useJUnitPlatform()
}

// ./gradlew :core:cli --args="convert SOURCE OUTPUT.xml --tz America/New_York"
tasks.register<JavaExec>("cli") {
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.smsconverter.sie2sbr.core.CliKt")
    maxHeapSize = "2g"
    workingDir = rootDir
}

// A runnable JAR of the engine's command line (with the Kotlin runtime inside), used by
// tests/test_all.py to compare this engine with the Python and browser versions:
//   java -jar core/build/libs/sie-cli.jar convert SOURCE OUTPUT.xml [options]
tasks.register<Jar>("cliJar") {
    archiveFileName.set("sie-cli.jar")
    manifest { attributes["Main-Class"] = "com.smsconverter.sie2sbr.core.CliKt" }
    from(sourceSets["main"].output)
    dependsOn(configurations.runtimeClasspath)
    from({ configurations.runtimeClasspath.get().map { if (it.isDirectory) it else zipTree(it) } })
    exclude("META-INF/*.SF", "META-INF/*.DSA", "META-INF/*.RSA", "META-INF/versions/**")
    duplicatesStrategy = DuplicatesStrategy.EXCLUDE
}
