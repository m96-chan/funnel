package com.github.m96chan.funnel

import android.app.Application
import android.content.Context
import android.os.Build
import androidx.core.content.edit
import com.github.m96chan.funnel.signaling.DeviceCapabilities
import java.util.UUID

class FunnelApp : Application()

/**
 * Defaults and the handful of values that survive a restart.
 *
 * The device id is generated once and kept forever — the registry keys presence
 * off it, so regenerating it would orphan the entry on the server.
 */
object FunnelConfig {

    /** 10.0.2.2 is the host machine as seen from the Android emulator. */
    const val DEFAULT_SERVER_URL = "ws://10.0.2.2:8080/ws"

    val DEFAULT_CAPABILITIES = DeviceCapabilities(
        video = true,
        audio = true,
        maxResolution = "1080p",
    )

    private const val PREFS = "funnel"
    private const val KEY_DEVICE_ID = "deviceId"
    private const val KEY_SERVER_URL = "serverUrl"
    private const val KEY_DEVICE_NAME = "deviceName"

    private fun prefs(context: Context) =
        context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun deviceId(context: Context): String {
        val prefs = prefs(context)
        prefs.getString(KEY_DEVICE_ID, null)?.let { return it }
        return UUID.randomUUID().toString().also {
            prefs.edit { putString(KEY_DEVICE_ID, it) }
        }
    }

    fun serverUrl(context: Context): String =
        prefs(context).getString(KEY_SERVER_URL, null) ?: DEFAULT_SERVER_URL

    fun setServerUrl(context: Context, url: String) =
        prefs(context).edit { putString(KEY_SERVER_URL, url) }

    fun deviceName(context: Context): String =
        prefs(context).getString(KEY_DEVICE_NAME, null) ?: defaultDeviceName()

    fun setDeviceName(context: Context, name: String) =
        prefs(context).edit { putString(KEY_DEVICE_NAME, name) }

    private fun defaultDeviceName(): String =
        listOf(Build.MANUFACTURER, Build.MODEL)
            .filter { it.isNotBlank() }
            .joinToString(" ")
            .ifBlank { "Android device" }
}
