package com.github.m96chan.funnel

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.github.m96chan.funnel.signaling.ConnectionState

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    PublisherScreen()
                }
            }
        }
    }
}

private val REQUIRED_PERMISSIONS: Array<String> = buildList {
    add(Manifest.permission.CAMERA)
    add(Manifest.permission.RECORD_AUDIO)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        add(Manifest.permission.POST_NOTIFICATIONS)
    }
}.toTypedArray()

private fun Context.hasAllPermissions(): Boolean = REQUIRED_PERMISSIONS.all {
    ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
}

@Composable
private fun PublisherScreen() {
    val context = LocalContext.current
    val state by PublisherService.state.collectAsStateWithLifecycle()
    val viewers by PublisherService.sessionCount.collectAsStateWithLifecycle()

    var serverUrl by remember { mutableStateOf(FunnelConfig.serverUrl(context)) }
    var deviceName by remember { mutableStateOf(FunnelConfig.deviceName(context)) }
    var granted by remember { mutableStateOf(context.hasAllPermissions()) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { result ->
        // Notifications being denied only costs us the visible notification, so
        // camera + mic are what actually gate publishing.
        granted = result[Manifest.permission.CAMERA] == true &&
            result[Manifest.permission.RECORD_AUDIO] == true
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        verticalArrangement = Arrangement.spacedBy(16.dp),
    ) {
        Text("Funnel", style = MaterialTheme.typography.headlineMedium)
        Text(
            text = "Device id: ${FunnelConfig.deviceId(context)}",
            style = MaterialTheme.typography.bodySmall,
        )

        OutlinedTextField(
            value = serverUrl,
            onValueChange = {
                serverUrl = it
                FunnelConfig.setServerUrl(context, it)
            },
            label = { Text(stringResource(R.string.server_url)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        OutlinedTextField(
            value = deviceName,
            onValueChange = {
                deviceName = it
                FunnelConfig.setDeviceName(context, it)
            },
            label = { Text(stringResource(R.string.device_name)) },
            singleLine = true,
            modifier = Modifier.fillMaxWidth(),
        )

        Text(
            text = "Status: ${state.label()}",
            style = MaterialTheme.typography.bodyLarge,
        )

        Text(
            text = when (viewers) {
                0 -> "No one is watching."
                1 -> "Streaming to 1 viewer."
                else -> "Streaming to $viewers viewers."
            },
            style = MaterialTheme.typography.bodyMedium,
        )

        if (!granted) {
            Button(
                onClick = { permissionLauncher.launch(REQUIRED_PERMISSIONS) },
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(stringResource(R.string.grant_permissions))
            }
        }

        Button(
            onClick = { PublisherService.start(context) },
            enabled = granted && state == ConnectionState.Disconnected,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.start_publishing))
        }

        OutlinedButton(
            onClick = { PublisherService.stop(context) },
            enabled = state != ConnectionState.Disconnected,
            modifier = Modifier.fillMaxWidth(),
        ) {
            Text(stringResource(R.string.stop_publishing))
        }

    }
}

private fun ConnectionState.label(): String = when (this) {
    ConnectionState.Disconnected -> "offline"
    ConnectionState.Connecting -> "connecting…"
    ConnectionState.Connected -> "handshaking"
    ConnectionState.Registered -> "registered"
}
