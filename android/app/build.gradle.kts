plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Číslo verze = pořadí sestavení na GitHubu, takže se každá nová verze nainstaluje přes tu starou.
val buildNumber = (System.getenv("GITHUB_RUN_NUMBER") ?: "1").toInt()

android {
    namespace = "cz.vaclavkotvalt.hudba"
    compileSdk = 35

    defaultConfig {
        applicationId = "cz.vaclavkotvalt.hudba"
        minSdk = 26
        targetSdk = 35
        versionCode = buildNumber
        versionName = "1.$buildNumber"
    }

    signingConfigs {
        // Stejný klíč u každé verze zajistí, že se nová verze nainstaluje přes starou.
        // Klíč i heslo jsou jen v tajných údajích GitHubu (HUDBA_KEYSTORE, HUDBA_KEYSTORE_PASSWORD),
        // workflow je předá přes proměnné prostředí.
        create("release") {
            storeFile = file(System.getenv("HUDBA_KEYSTORE_FILE") ?: "../hudba.keystore")
            storePassword = System.getenv("HUDBA_KEYSTORE_PASSWORD")
            keyAlias = "hudba"
            keyPassword = System.getenv("HUDBA_KEYSTORE_PASSWORD")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webAssets").get().asFile)
}

// Vzhled (styly, písma, ikony) se bere z webové verze v hudba/, aby se neudržoval dvakrát.
val copyWebAssets by tasks.registering(Sync::class) {
    from("../../hudba") {
        include("style.css", "icons.js", "fonts/**", "icons/**")
        into("web")
    }
    from("../web") {
        into("web")
    }
    into(layout.buildDirectory.dir("generated/webAssets"))
}
tasks.named("preBuild") {
    dependsOn(copyWebAssets)
}

dependencies {
    implementation("androidx.media3:media3-exoplayer:1.5.1")
    implementation("androidx.media3:media3-session:1.5.1")
    implementation("androidx.webkit:webkit:1.12.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.core:core-ktx:1.15.0")
}
