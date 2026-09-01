package com.github.m96chan.funnel.signaling

import android.content.Context
import android.os.BatteryManager
import android.util.Log
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** Everything the client needs to identify itself to the registry. */
data class SignalingConfig(
    val serverUrl: String,
    val deviceId: String,
    val deviceName: String,
    val capabilities: DeviceCapabilities,
    /** Pairing/auth token. Unused until the server defines one. */
    val token: String? = null,
)

enum class ConnectionState { Disconnected, Connecting, Connected, Registered }

/**
 * Publisher side of the signaling protocol: opens a WebSocket, says `hello`,
 * `register`s, heartbeats, and surfaces relayed WebRTC messages as [events].
 *
 * This class is real and complete. What it does *not* do is act on an offer —
 * it hands [ServerEvent.Offer] to the caller, and the caller is expected to
 * produce an answer via [sendAnswer]. See PublisherService for that seam.
 */
class SignalingClient(
    context: Context,
    private val config: SignalingConfig,
    private val httpClient: OkHttpClient = defaultHttpClient(),
) : WebSocketListener() {

    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val _state = MutableStateFlow(ConnectionState.Disconnected)
    val state: StateFlow<ConnectionState> = _state.asStateFlow()

    private val _events = MutableSharedFlow<ServerEvent>(extraBufferCapacity = 64)
    val events: SharedFlow<ServerEvent> = _events.asSharedFlow()

    /** Id the server assigned in `hello-ack`. Null until the handshake lands. */
    @Volatile var connectionId: String? = null
        private set

    /** Reported in every heartbeat. Set by the media layer once it exists. */
    @Volatile var streaming: Boolean = false

    private var webSocket: WebSocket? = null
    private var heartbeatJob: Job? = null
    private var reconnectJob: Job? = null
    private var heartbeatIntervalMs: Long = HEARTBEAT_INTERVAL_MS
    private var attempt = 0

    @Volatile private var stopped = true

    fun connect() {
        if (!stopped) return
        stopped = false
        attempt = 0
        openSocket()
    }

    /** Sends `unregister`, closes the socket and stops reconnecting. */
    fun disconnect() {
        stopped = true
        reconnectJob?.cancel()
        heartbeatJob?.cancel()
        webSocket?.let { socket ->
            runCatching {
                socket.send(
                    Protocol.encode(
                        MessageType.UNREGISTER,
                        UnregisterPayload(config.deviceId),
                    ),
                )
            }
            socket.close(NORMAL_CLOSURE, "client disconnect")
        }
        webSocket = null
        _state.value = ConnectionState.Disconnected
    }

    /** Releases the coroutine scope. The instance is unusable afterwards. */
    fun shutdown() {
        disconnect()
        scope.cancel()
    }

    /* ---------------- outbound ---------------- */

    fun sendAnswer(to: String?, sessionId: String, sdp: String) =
        send(Protocol.encode(MessageType.ANSWER, AnswerPayload(sessionId, sdp), to = to))

    fun sendIceCandidate(
        to: String?,
        sessionId: String,
        candidate: String,
        sdpMid: String?,
        sdpMLineIndex: Int?,
    ) = send(
        Protocol.encode(
            MessageType.ICE_CANDIDATE,
            IceCandidatePayload(sessionId, candidate, sdpMid, sdpMLineIndex),
            to = to,
        ),
    )

    fun sendSessionEnd(to: String?, sessionId: String, reason: String? = null) =
        send(Protocol.encode(MessageType.SESSION_END, SessionEndPayload(sessionId, reason), to = to))

    private fun send(text: String): Boolean {
        val socket = webSocket
        if (socket == null) {
            Log.w(TAG, "dropping frame, socket is not open")
            return false
        }
        return socket.send(text)
    }

    /* ---------------- WebSocketListener ---------------- */

    override fun onOpen(webSocket: WebSocket, response: Response) {
        Log.i(TAG, "socket open -> ${config.serverUrl}")
        this.webSocket = webSocket
        attempt = 0
        _state.value = ConnectionState.Connected
        webSocket.send(
            Protocol.encode(
                MessageType.HELLO,
                HelloPayload(PROTOCOL_VERSION, Role.PUBLISHER, config.token),
            ),
        )
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        val event = Protocol.decode(text)
        if (event == null) {
            Log.w(TAG, "undecodable frame dropped")
            return
        }
        when (event) {
            is ServerEvent.HelloAck -> {
                connectionId = event.payload.id
                heartbeatIntervalMs = event.payload.heartbeatIntervalMs
                if (event.payload.protocolVersion != PROTOCOL_VERSION) {
                    Log.w(
                        TAG,
                        "protocol version mismatch: server=${event.payload.protocolVersion} " +
                            "app=$PROTOCOL_VERSION",
                    )
                }
                sendRegister()
            }

            is ServerEvent.Registered -> {
                _state.value = ConnectionState.Registered
                startHeartbeat()
            }

            is ServerEvent.Failure ->
                Log.e(TAG, "server error ${event.payload.code}: ${event.payload.message}")

            is ServerEvent.Unhandled ->
                Log.d(TAG, "ignoring ${event.envelope.type}")

            else -> Unit
        }
        _events.tryEmit(event)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        Log.w(TAG, "socket failed: ${t.message}")
        onSocketGone()
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        webSocket.close(NORMAL_CLOSURE, null)
    }

    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
        Log.i(TAG, "socket closed ($code) $reason")
        onSocketGone()
    }

    /* ---------------- internals ---------------- */

    private fun openSocket() {
        _state.value = ConnectionState.Connecting
        val request = Request.Builder().url(config.serverUrl).build()
        httpClient.newWebSocket(request, this)
    }

    private fun onSocketGone() {
        webSocket = null
        heartbeatJob?.cancel()
        connectionId = null
        _state.value = ConnectionState.Disconnected
        if (stopped) return
        scheduleReconnect()
    }

    /** Exponential backoff with jitter, capped so a long outage still retries. */
    private fun scheduleReconnect() {
        if (reconnectJob?.isActive == true) return
        val delayMs = min(MAX_BACKOFF_MS, BASE_BACKOFF_MS shl min(attempt, 5)) +
            Random.nextLong(BASE_BACKOFF_MS)
        attempt++
        reconnectJob = scope.launch {
            Log.i(TAG, "reconnecting in ${delayMs}ms (attempt $attempt)")
            delay(delayMs)
            if (!stopped) openSocket()
        }
    }

    private fun sendRegister() {
        send(
            Protocol.encode(
                MessageType.REGISTER,
                RegisterPayload(
                    deviceId = config.deviceId,
                    name = config.deviceName,
                    capabilities = config.capabilities,
                    battery = batteryLevel(),
                ),
            ),
        )
    }

    private fun startHeartbeat() {
        heartbeatJob?.cancel()
        heartbeatJob = scope.launch {
            while (isActive) {
                delay(heartbeatIntervalMs)
                val ok = send(
                    Protocol.encode(
                        MessageType.HEARTBEAT,
                        HeartbeatPayload(battery = batteryLevel(), streaming = streaming),
                    ),
                )
                if (!ok) break
            }
        }
    }

    /** 0..1, or null when the platform will not report a level. */
    private fun batteryLevel(): Double? {
        val manager = appContext.getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
            ?: return null
        val percent = manager.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (percent in 0..100) percent / 100.0 else null
    }

    companion object {
        private const val TAG = "FunnelSignaling"
        private const val NORMAL_CLOSURE = 1000
        private const val BASE_BACKOFF_MS = 1_000L
        private const val MAX_BACKOFF_MS = 30_000L

        /** pingInterval keeps idle proxies/NATs from dropping the socket. */
        fun defaultHttpClient(): OkHttpClient = OkHttpClient.Builder()
            .pingInterval(20, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            .build()
    }
}
