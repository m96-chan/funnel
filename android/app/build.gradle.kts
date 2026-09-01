plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.github.m96chan.funnel"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.github.m96chan.funnel"
        // 26: foreground services + the notification channel API the publisher
        // service relies on. libwebrtc also drops below-26 support.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }

    buildTypes {
        debug {
            isMinifyEnabled = false
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    buildFeatures {
        compose = true
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.service)
    implementation(libs.androidx.activity.compose)

    val composeBom = platform(libs.androidx.compose.bom)
    implementation(composeBom)
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.graphics)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.ui.tooling.preview)
    debugImplementation(libs.androidx.compose.ui.tooling)

    // Signaling: OkHttp for the WebSocket, kotlinx.serialization for the envelope.
    implementation(libs.okhttp)
    implementation(libs.kotlinx.serialization.json)

    // libwebrtc prebuilt — transport *and* capture. `org.webrtc:google-webrtc`
    // has been unmaintained since M92; io.github.webrtc-sdk:android is the
    // community fork that tracks upstream.
    //
    // No CameraX here on purpose: libwebrtc's own Camera2Enumerator/
    // SurfaceTextureHelper path hands the encoder texture frames, while driving
    // WebRTC from CameraX means copying every YUV_420_888 buffer on the CPU.
    implementation(libs.webrtc.android)
}
