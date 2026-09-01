package com.github.m96chan.funnel.media

import android.content.Context
import android.util.Log
import com.github.m96chan.funnel.signaling.IceServer
import org.webrtc.AudioSource
import org.webrtc.AudioTrack
import org.webrtc.Camera2Enumerator
import org.webrtc.DefaultVideoDecoderFactory
import org.webrtc.DefaultVideoEncoderFactory
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnection
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack
import org.webrtc.audio.JavaAudioDeviceModule

/**
 * Owns everything that is expensive and shared: the [PeerConnectionFactory],
 * the EGL context, the camera capturer and the local audio/video tracks.
 *
 * Capture is reference-counted by session ([acquire] / [release]) so the camera
 * light only comes on while somebody is actually watching. The same
 * [VideoTrack]/[AudioTrack] instances are added to every peer connection —
 * libwebrtc encodes once per subscriber but captures once, full stop.
 *
 * The capturer is libwebrtc's own [Camera2Enumerator]-backed one rather than
 * CameraX: it hands the encoder texture frames through [SurfaceTextureHelper],
 * whereas driving WebRTC from CameraX means copying every YUV_420_888 buffer on
 * the CPU. Same camera, an order of magnitude less work per frame.
 */
class MediaEngine(context: Context) {

    private val appContext = context.applicationContext
    private val eglBase: EglBase = EglBase.create()

    /** libwebrtc owns AudioRecord through this; we never touch PCM by hand. */
    private val audioDeviceModule = JavaAudioDeviceModule.builder(appContext)
        .createAudioDeviceModule()

    private val factory: PeerConnectionFactory

    private var capturer: VideoCapturer? = null
    private var surfaceHelper: SurfaceTextureHelper? = null
    private var videoSource: VideoSource? = null
    private var audioSource: AudioSource? = null

    var videoTrack: VideoTrack? = null
        private set
    var audioTrack: AudioTrack? = null
        private set

    private var activeSessions = 0

    val eglBaseContext: EglBase.Context get() = eglBase.eglBaseContext

    init {
        PeerConnectionFactory.initialize(
            PeerConnectionFactory.InitializationOptions.builder(appContext)
                .createInitializationOptions(),
        )
        factory = PeerConnectionFactory.builder()
            // `true, true` enables the Intel VP8 and H.264 hardware paths.
            .setVideoEncoderFactory(DefaultVideoEncoderFactory(eglBase.eglBaseContext, true, true))
            .setVideoDecoderFactory(DefaultVideoDecoderFactory(eglBase.eglBaseContext))
            .setAudioDeviceModule(audioDeviceModule)
            .createPeerConnectionFactory()
    }

    /**
     * Start capture if this is the first session. Returns false when there is
     * no usable camera, in which case the caller should refuse the offer rather
     * than answer with a track that will never produce a frame.
     */
    @Synchronized
    fun acquire(resolution: String): Boolean {
        if (activeSessions == 0 && !startCapture(resolution)) return false
        activeSessions++
        return true
    }

    /** Release one session's claim; the camera stops when the last one goes. */
    @Synchronized
    fun release() {
        if (activeSessions == 0) return
        activeSessions--
        if (activeSessions == 0) stopCapture()
    }

    @Synchronized
    fun createPeerConnection(
        iceServers: List<IceServer>,
        observer: PeerConnection.Observer,
    ): PeerConnection? {
        val config = PeerConnection.RTCConfiguration(iceServers.toNative()).apply {
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // Keep gathering after the first candidate so a network change mid-call
            // can still produce a working pair without renegotiating.
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
        }
        return factory.createPeerConnection(config, observer)
    }

    @Synchronized
    fun dispose() {
        activeSessions = 0
        stopCapture()
        factory.dispose()
        audioDeviceModule.release()
        eglBase.release()
    }

    private fun startCapture(resolution: String): Boolean {
        val enumerator = Camera2Enumerator(appContext)
        val deviceName = enumerator.deviceNames.firstOrNull { enumerator.isBackFacing(it) }
            ?: enumerator.deviceNames.firstOrNull()
        if (deviceName == null) {
            Log.e(TAG, "no camera available")
            return false
        }

        val created = enumerator.createCapturer(deviceName, null)
        if (created == null) {
            Log.e(TAG, "could not open camera $deviceName")
            return false
        }

        val helper = SurfaceTextureHelper.create("FunnelCapture", eglBase.eglBaseContext)
        // `false` = not a screencast; lets the encoder drop resolution under load.
        val source = factory.createVideoSource(false)
        created.initialize(helper, appContext, source.capturerObserver)

        val (width, height) = resolution.toDimensions()
        created.startCapture(width, height, FRAME_RATE)

        capturer = created
        surfaceHelper = helper
        videoSource = source
        videoTrack = factory.createVideoTrack(VIDEO_TRACK_ID, source)

        val audio = factory.createAudioSource(MediaConstraints())
        audioSource = audio
        audioTrack = factory.createAudioTrack(AUDIO_TRACK_ID, audio)

        Log.i(TAG, "capturing $deviceName at ${width}x$height@$FRAME_RATE")
        return true
    }

    private fun stopCapture() {
        videoTrack?.dispose()
        videoTrack = null
        audioTrack?.dispose()
        audioTrack = null

        capturer?.let {
            runCatching { it.stopCapture() }.onFailure { e -> Log.w(TAG, "stopCapture", e) }
            it.dispose()
        }
        capturer = null

        surfaceHelper?.dispose()
        surfaceHelper = null
        videoSource?.dispose()
        videoSource = null
        audioSource?.dispose()
        audioSource = null
    }

    private companion object {
        const val TAG = "FunnelMedia"
        const val VIDEO_TRACK_ID = "funnel-video"
        const val AUDIO_TRACK_ID = "funnel-audio"
        const val FRAME_RATE = 30

        /**
         * The capturer needs pixels, the protocol speaks in labels. Anything
         * unrecognised falls back to 720p — a resolution every camera supports.
         */
        fun String.toDimensions(): Pair<Int, Int> = when (lowercase()) {
            "2160p", "4k" -> 3840 to 2160
            "1440p" -> 2560 to 1440
            "1080p" -> 1920 to 1080
            "480p" -> 854 to 480
            else -> 1280 to 720
        }

        fun List<IceServer>.toNative(): List<PeerConnection.IceServer> = map { server ->
            PeerConnection.IceServer.builder(server.urls)
                .setUsername(server.username.orEmpty())
                .setPassword(server.credential.orEmpty())
                .createIceServer()
        }
    }
}
