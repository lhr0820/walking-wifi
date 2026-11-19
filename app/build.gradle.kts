import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 读取签名配置。keystore.properties 不进版本库（见 .gitignore），
// 没有这个文件时也能正常构建 debug 包，只是打不了 release。
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) {
        keystorePropsFile.inputStream().use { load(it) }
    }
}
val hasSigning = keystorePropsFile.exists() &&
    keystoreProps.getProperty("storeFile") != null

android {
    namespace = "com.walkingwifi.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.walkingwifi.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.2.0"
    }

    signingConfigs {
        if (hasSigning) {
            create("release") {
                storeFile = rootProject.file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            isShrinkResources = false
            if (hasSigning) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
        debug {
            applicationIdSuffix = ".debug"
            versionNameSuffix = "-debug"
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        viewBinding = true
    }
    packaging {
        resources.excludes += setOf(
            "META-INF/DEPENDENCIES",
            "META-INF/LICENSE*",
            "META-INF/NOTICE*"
        )
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
}
