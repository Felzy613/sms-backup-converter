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
