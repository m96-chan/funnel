package com.github.m96chan.funnel

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.lifecycle.LifecycleService
import androidx.lifecycle.lifecycleScope
import com.github.m96chan.funnel.media.MediaEngine
import com.github.m96chan.funnel.media.PublisherSession
import com.github.m96chan.funnel.signaling.ConnectionState
import com.github.m96chan.funnel.signaling.IceServer
import com.github.m96chan.funnel.signaling.ServerEvent
import com.github.m96chan.funnel.signaling.SignalingClient
import com.github.m96chan.funnel.signaling.SignalingConfig
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import org.webrtc.IceCandidate
import java.util.concurrent.ConcurrentHashMap

/**
 * Keeps the publisher alive with the screen off, and owns everything a session
 * needs: the signaling socket, the [MediaEngine], and one [PublisherSession]
 * per watching subscriber.
 *
 * A [LifecycleService] so `lifecycleScope` follows the service's own lifetime.
 */
class PublisherService : LifecycleService(), PublisherSession.Callbacks {

    private var signaling: SignalingClient? = null
    private var engine: MediaEngine? = null

    /** Handed to every new peer connection; arrives with `hello-ack`. */
    @Volatile
    private var iceServers: List<IceServer> = emptyList()

    private val sessions = ConcurrentHashMap<String, PublisherSession>()

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        super.onStartCommand(intent, flags, startId)

        when (intent?.action) {
            ACTION_STOP -> {
                stopPublishing()
                return START_NOT_STICKY
            }
            else -> startPublishing()
        }
        return START_STICKY
    }

    private fun startPublishing() {
        if (signaling != null) return

        // On API 34+ this throws unless CAMERA/RECORD_AUDIO are already granted,
        // which is why MainActivity asks before it starts the service.
        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            buildNotification(),
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA or
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                0
            },
        )

        engine = MediaEngine(this)

        val client = SignalingClient(
            context = this,
            config = SignalingConfig(
                serverUrl = FunnelConfig.serverUrl(this),
                deviceId = FunnelConfig.deviceId(this),
                deviceName = FunnelConfig.deviceName(this),
                capabilities = FunnelConfig.DEFAULT_CAPABILITIES,
            ),
        )
        signaling = client

        lifecycleScope.launch { client.state.collect { _state.value = it } }
        lifecycleScope.launch { client.events.collect(::onSignalingEvent) }

        client.connect()
    }

    /* ---------------- signaling in ---------------- */

    private fun onSignalingEvent(event: ServerEvent) {
        when (event) {
            is ServerEvent.HelloAck -> {
                iceServers = event.payload.iceServers
            }

            is ServerEvent.Offer -> openSession(event)

            is ServerEvent.IceCandidate -> {
                val payload = event.payload
                sessions[payload.sessionId]?.addRemoteCandidate(
                    IceCandidate(payload.sdpMid, payload.sdpMLineIndex ?: 0, payload.candidate),
                ) ?: Log.w(TAG, "candidate for unknown session ${payload.sessionId}")
            }

            is ServerEvent.SessionEnd -> {
                Log.i(TAG, "session ${event.payload.sessionId} ended: ${event.payload.reason}")
                endSession(event.payload.sessionId, notifyPeer = null)
            }

            else -> Unit
        }
    }

    private fun openSession(event: ServerEvent.Offer) {
        val sessionId = event.payload.sessionId
        val engine = engine ?: return
        if (sessions.containsKey(sessionId)) {
            Log.w(TAG, "duplicate offer for session $sessionId, ignoring")
            return
        }

        if (!engine.acquire(FunnelConfig.DEFAULT_CAPABILITIES.maxResolution)) {
            Log.e(TAG, "no camera; refusing session $sessionId")
            signaling?.sendSessionEnd(event.from, sessionId, reason = "capture-unavailable")
            return
        }

        val session = PublisherSession(
            sessionId = sessionId,
            peerId = event.from,
            engine = engine,
            iceServers = iceServers,
            callbacks = this,
        )
        if (!session.isValid) {
            engine.release()
            signaling?.sendSessionEnd(event.from, sessionId, reason = "peer-connection-failed")
            return
        }

        sessions[sessionId] = session
        onSessionCountChanged()
        session.acceptOffer(event.payload.sdp)
    }

    /* ---------------- signaling out (PublisherSession.Callbacks) ---------------- */

    override fun onAnswer(session: PublisherSession, sdp: String) {
        signaling?.sendAnswer(session.peerId, session.sessionId, sdp)
    }

    override fun onLocalCandidate(session: PublisherSession, candidate: IceCandidate) {
        signaling?.sendIceCandidate(
            to = session.peerId,
            sessionId = session.sessionId,
            candidate = candidate.sdp,
            sdpMid = candidate.sdpMid,
            sdpMLineIndex = candidate.sdpMLineIndex,
        )
    }

    override fun onFailed(session: PublisherSession, reason: String) {
        Log.w(TAG, "session ${session.sessionId} failed: $reason")
        endSession(session.sessionId, notifyPeer = reason)
    }

    /* ---------------- teardown ---------------- */

    private fun endSession(sessionId: String, notifyPeer: String?) {
        val session = sessions.remove(sessionId) ?: return
        if (notifyPeer != null) {
            signaling?.sendSessionEnd(session.peerId, sessionId, notifyPeer)
        }
        session.close()
        engine?.release()
        onSessionCountChanged()
    }

    private fun endAllSessions() {
        sessions.keys.toList().forEach { endSession(it, notifyPeer = "publisher-stopped") }
    }

    /** Keeps the heartbeat's `streaming` flag and the UI honest. */
    private fun onSessionCountChanged() {
        val count = sessions.size
        signaling?.streaming = count > 0
        _sessionCount.value = count
    }

    private fun stopPublishing() {
        shutdown()
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        stopSelf()
    }

    override fun onDestroy() {
        shutdown()
        super.onDestroy()
    }

    private fun shutdown() {
        endAllSessions()
        signaling?.shutdown()
        signaling = null
        engine?.dispose()
        engine = null
        iceServers = emptyList()
        _state.value = ConnectionState.Disconnected
        _sessionCount.value = 0
    }

    /* ---------------- notification ---------------- */

    private fun buildNotification() = NotificationCompat.Builder(this, CHANNEL_ID)
        .setContentTitle(getString(R.string.notification_title))
        .setContentText(getString(R.string.notification_text))
        .setSmallIcon(android.R.drawable.presence_video_online)
        .setOngoing(true)
        .setContentIntent(
            PendingIntent.getActivity(
                this,
                0,
                Intent(this, MainActivity::class.java),
                PendingIntent.FLAG_IMMUTABLE,
            ),
        )
        .build()

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = getString(R.string.notification_channel_description) }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val TAG = "FunnelPublisher"
        private const val CHANNEL_ID = "funnel.publishing"
        private const val NOTIFICATION_ID = 1

        const val ACTION_START = "com.github.m96chan.funnel.START"
        const val ACTION_STOP = "com.github.m96chan.funnel.STOP"

        /**
         * Process-wide state for the UI. A bound service or a repository would
         * be tidier; this is the smallest thing that lets MainActivity show
         * what the service is doing.
         */
        private val _state = MutableStateFlow(ConnectionState.Disconnected)
        val state: StateFlow<ConnectionState> = _state.asStateFlow()

        private val _sessionCount = MutableStateFlow(0)

        /** How many subscribers are watching right now. */
        val sessionCount: StateFlow<Int> = _sessionCount.asStateFlow()

        fun start(context: Context) {
            val intent = Intent(context, PublisherService::class.java).setAction(ACTION_START)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, PublisherService::class.java).setAction(ACTION_STOP)
            context.startService(intent)
        }
    }
}
