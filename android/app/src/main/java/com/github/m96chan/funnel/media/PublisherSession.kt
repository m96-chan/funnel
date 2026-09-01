package com.github.m96chan.funnel.media

import android.util.Log
import com.github.m96chan.funnel.signaling.IceServer
import org.webrtc.DataChannel
import org.webrtc.IceCandidate
import org.webrtc.MediaConstraints
import org.webrtc.MediaStream
import org.webrtc.MediaStreamTrack
import org.webrtc.PeerConnection
import org.webrtc.RtpReceiver
import org.webrtc.SdpObserver
import org.webrtc.SessionDescription

/**
 * One subscriber's WebRTC session: answer their offer, trickle candidates, and
 * push the shared camera/mic tracks at them.
 *
 * The phone is always the answerer — the dashboard offers `recvonly`, so adding
 * our tracks before answering produces a `sendonly` answer without any explicit
 * direction juggling.
 */
class PublisherSession(
    val sessionId: String,
    /** Server-assigned id of the subscriber; where replies are addressed. */
    val peerId: String?,
    private val engine: MediaEngine,
    iceServers: List<IceServer>,
    private val callbacks: Callbacks,
) {

    interface Callbacks {
        fun onLocalCandidate(session: PublisherSession, candidate: IceCandidate)
        fun onAnswer(session: PublisherSession, sdp: String)
        /** Terminal failure — the service should tear this session down. */
        fun onFailed(session: PublisherSession, reason: String)
    }

    /**
     * Candidates that arrived before `setRemoteDescription` completed.
     * libwebrtc rejects `addIceCandidate` until then, and trickled candidates
     * routinely beat the answer's round trip.
     */
    private val pendingCandidates = mutableListOf<IceCandidate>()
    private var remoteDescriptionSet = false
    private var closed = false

    private val peerConnection: PeerConnection? =
        engine.createPeerConnection(iceServers, PeerObserver())

    val isValid: Boolean get() = peerConnection != null

    init {
        val pc = peerConnection
        if (pc == null) {
            Log.e(TAG, "[$sessionId] could not create the peer connection")
        } else {
            engine.videoTrack?.let { pc.addTrack(it, listOf(STREAM_ID)) }
            engine.audioTrack?.let { pc.addTrack(it, listOf(STREAM_ID)) }
        }
    }

    fun acceptOffer(sdp: String) {
        val pc = peerConnection ?: return
        pc.setRemoteDescription(
            object : SdpObserverAdapter("setRemoteDescription") {
                override fun onSetSuccess() {
                    synchronized(this@PublisherSession) {
                        remoteDescriptionSet = true
                        pendingCandidates.forEach(pc::addIceCandidate)
                        pendingCandidates.clear()
                    }
                    createAnswer()
                }

                override fun onSetFailure(error: String?) {
                    super.onSetFailure(error)
                    callbacks.onFailed(this@PublisherSession, "setRemoteDescription: $error")
                }
            },
            SessionDescription(SessionDescription.Type.OFFER, sdp),
        )
    }

    @Synchronized
    fun addRemoteCandidate(candidate: IceCandidate) {
        val pc = peerConnection ?: return
        if (remoteDescriptionSet) pc.addIceCandidate(candidate) else pendingCandidates.add(candidate)
    }

    @Synchronized
    fun close() {
        if (closed) return
        closed = true
        pendingCandidates.clear()
        peerConnection?.let {
            // Tracks are shared with every other session, so they are the
            // engine's to dispose — the connection only lets go of them.
            it.senders.forEach { sender -> sender.setTrack(null as MediaStreamTrack?, false) }
            it.close()
            it.dispose()
        }
    }

    private fun createAnswer() {
        val pc = peerConnection ?: return
        pc.createAnswer(
            object : SdpObserverAdapter("createAnswer") {
                override fun onCreateSuccess(description: SessionDescription?) {
                    val answer = description ?: return
                    pc.setLocalDescription(
                        object : SdpObserverAdapter("setLocalDescription") {
                            override fun onSetSuccess() {
                                callbacks.onAnswer(this@PublisherSession, answer.description)
                            }

                            override fun onSetFailure(error: String?) {
                                super.onSetFailure(error)
                                callbacks.onFailed(
                                    this@PublisherSession,
                                    "setLocalDescription: $error",
                                )
                            }
                        },
                        answer,
                    )
                }

                override fun onCreateFailure(error: String?) {
                    super.onCreateFailure(error)
                    callbacks.onFailed(this@PublisherSession, "createAnswer: $error")
                }
            },
            MediaConstraints(),
        )
    }

    private inner class PeerObserver : PeerConnection.Observer {
        override fun onIceCandidate(candidate: IceCandidate?) {
            candidate ?: return
            callbacks.onLocalCandidate(this@PublisherSession, candidate)
        }

        override fun onIceConnectionChange(state: PeerConnection.IceConnectionState?) {
            Log.i(TAG, "[$sessionId] ice=$state")
            if (state == PeerConnection.IceConnectionState.FAILED) {
                callbacks.onFailed(this@PublisherSession, "ice-failed")
            }
        }

        override fun onSignalingChange(state: PeerConnection.SignalingState?) = Unit
        override fun onIceConnectionReceivingChange(receiving: Boolean) = Unit
        override fun onIceGatheringChange(state: PeerConnection.IceGatheringState?) = Unit
        override fun onIceCandidatesRemoved(candidates: Array<out IceCandidate>?) = Unit
        override fun onAddStream(stream: MediaStream?) = Unit
        override fun onRemoveStream(stream: MediaStream?) = Unit
        override fun onDataChannel(channel: DataChannel?) = Unit

        /** Never fires here: the phone only ever answers, it never renegotiates. */
        override fun onRenegotiationNeeded() = Unit

        override fun onAddTrack(receiver: RtpReceiver?, streams: Array<out MediaStream>?) = Unit
    }

    private open inner class SdpObserverAdapter(private val op: String) : SdpObserver {
        override fun onCreateSuccess(description: SessionDescription?) = Unit
        override fun onSetSuccess() = Unit
        override fun onCreateFailure(error: String?) = Log.e(TAG, "[$sessionId] $op: $error")
        override fun onSetFailure(error: String?) = Log.e(TAG, "[$sessionId] $op: $error")
    }

    private companion object {
        const val TAG = "FunnelSession"
        const val STREAM_ID = "funnel"
    }
}
