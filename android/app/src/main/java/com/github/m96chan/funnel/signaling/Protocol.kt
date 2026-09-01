package com.github.m96chan.funnel.signaling

import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonTransformingSerializer
import kotlinx.serialization.json.encodeToJsonElement

/**
 * Kotlin mirror of `shared/src/protocol.ts`.
 *
 * Field names, message type strings and constants are copied verbatim from the
 * TypeScript contract — if you change one side, change both.
 */

/** Protocol version carried in the `hello` handshake. */
const val PROTOCOL_VERSION: Int = 1

/** How often a publisher is expected to send a heartbeat. */
const val HEARTBEAT_INTERVAL_MS: Long = 10_000

/** Presence TTL — a device with no heartbeat inside this window goes offline. */
const val PRESENCE_TTL_MS: Long = 30_000

object MessageType {
    // client -> server
    const val HELLO = "hello"
    const val REGISTER = "register"
    const val HEARTBEAT = "heartbeat"
    const val UNREGISTER = "unregister"
    const val LIST_DEVICES = "list-devices"

    // relayed peer to peer
    const val OFFER = "offer"
    const val ANSWER = "answer"
    const val ICE_CANDIDATE = "ice-candidate"
    const val SESSION_END = "session-end"

    // server -> client
    const val HELLO_ACK = "hello-ack"
    const val REGISTERED = "registered"
    const val DEVICE_LIST = "device-list"
    const val DEVICE_UPDATED = "device-updated"
    const val DEVICE_REMOVED = "device-removed"
    const val ERROR = "error"
}

object Role {
    const val PUBLISHER = "publisher"
    const val SUBSCRIBER = "subscriber"
}

/** `ErrorPayload.code` values. Kept as strings so an unknown code still decodes. */
object ErrorCode {
    const val UNAUTHORIZED = "unauthorized"
    const val PROTOCOL_VERSION_MISMATCH = "protocol-version-mismatch"
    const val MALFORMED_MESSAGE = "malformed-message"
    const val UNKNOWN_DEVICE = "unknown-device"
    const val DEVICE_OFFLINE = "device-offline"
    const val NOT_REGISTERED = "not-registered"
    const val INTERNAL = "internal"
}

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

/**
 * The common envelope. `payload` stays a [JsonElement] because its shape depends
 * on `type` — decoding is two-step: envelope first, then [Protocol.payload].
 *
 * `from`, `to` and `requestId` default to null and are therefore *omitted* when
 * encoding (encodeDefaults is off), which is what the server expects for the
 * first message and for messages addressed to the server itself.
 */
@Serializable
data class Envelope(
    val type: String,
    val from: String? = null,
    val to: String? = null,
    val requestId: String? = null,
    val payload: JsonElement,
)

/* ------------------------------------------------------------------ *
 * Payloads
 * ------------------------------------------------------------------ */

@Serializable
data class DeviceCapabilities(
    val video: Boolean,
    val audio: Boolean,
    /** e.g. "720p", "1080p" — best resolution the device will publish. */
    val maxResolution: String,
)

@Serializable
data class DeviceInfo(
    val deviceId: String,
    val name: String,
    val capabilities: DeviceCapabilities,
    val online: Boolean,
    val streaming: Boolean,
    /** 0..1, or null when the device does not report it. */
    val battery: Double?,
    val lastSeenAt: Long,
)

/** `urls` is `string | string[]` on the wire; normalised to a list here. */
@Serializable
data class IceServer(
    @Serializable(with = StringOrStringListSerializer::class)
    val urls: List<String>,
    val username: String? = null,
    val credential: String? = null,
)

object StringOrStringListSerializer :
    JsonTransformingSerializer<List<String>>(ListSerializer(String.serializer())) {
    override fun transformDeserialize(element: JsonElement): JsonElement =
        if (element is JsonArray) element else JsonArray(listOf(element))
}

@Serializable
data class HelloPayload(
    val protocolVersion: Int,
    val role: String,
    val token: String? = null,
)

@Serializable
data class HelloAckPayload(
    val protocolVersion: Int,
    /** Id the server assigned to this connection. */
    val id: String,
    val iceServers: List<IceServer> = emptyList(),
    val heartbeatIntervalMs: Long = HEARTBEAT_INTERVAL_MS,
)

@Serializable
data class RegisterPayload(
    val deviceId: String,
    val name: String,
    val capabilities: DeviceCapabilities,
    val battery: Double? = null,
)

@Serializable
data class RegisteredPayload(val device: DeviceInfo)

@Serializable
data class HeartbeatPayload(
    val battery: Double? = null,
    val streaming: Boolean? = null,
)

@Serializable
data class UnregisterPayload(val deviceId: String)

@Serializable
data class OfferPayload(
    val sessionId: String,
    val sdp: String,
)

@Serializable
data class AnswerPayload(
    val sessionId: String,
    val sdp: String,
)

@Serializable
data class IceCandidatePayload(
    val sessionId: String,
    val candidate: String,
    // Required-but-nullable on the wire: no Kotlin default, so they are always
    // encoded, as `null` when absent.
    val sdpMid: String?,
    val sdpMLineIndex: Int?,
)

@Serializable
data class SessionEndPayload(
    val sessionId: String,
    val reason: String? = null,
)

@Serializable
data class ErrorPayload(
    val code: String,
    val message: String,
)

/* ------------------------------------------------------------------ *
 * Inbound events the publisher cares about
 * ------------------------------------------------------------------ */

/**
 * Decoded server -> publisher message. Discovery messages (`device-list`,
 * `device-updated`, `device-removed`) only go to subscribers, so they land in
 * [Unhandled] here rather than getting their own type.
 */
sealed interface ServerEvent {
    data class HelloAck(val payload: HelloAckPayload) : ServerEvent
    data class Registered(val payload: RegisteredPayload) : ServerEvent
    data class Offer(val from: String?, val payload: OfferPayload) : ServerEvent
    data class IceCandidate(val from: String?, val payload: IceCandidatePayload) : ServerEvent
    data class SessionEnd(val from: String?, val payload: SessionEndPayload) : ServerEvent
    data class Failure(val payload: ErrorPayload) : ServerEvent
    data class Unhandled(val envelope: Envelope) : ServerEvent
}

/* ------------------------------------------------------------------ *
 * Codec
 * ------------------------------------------------------------------ */

object Protocol {

    /**
     * `ignoreUnknownKeys` so a server that adds a field does not break older
     * apps. `encodeDefaults` stays off (the default) so null-defaulted optional
     * fields are omitted rather than sent as explicit nulls.
     */
    val json: Json = Json {
        ignoreUnknownKeys = true
        isLenient = false
    }

    /** Encodes an outbound message. */
    inline fun <reified T> encode(
        type: String,
        payload: T,
        from: String? = null,
        to: String? = null,
        requestId: String? = null,
    ): String {
        val envelope = Envelope(
            type = type,
            from = from,
            to = to,
            requestId = requestId,
            payload = json.encodeToJsonElement(payload),
        )
        return json.encodeToString(Envelope.serializer(), envelope)
    }

    fun decodeEnvelope(text: String): Envelope =
        json.decodeFromString(Envelope.serializer(), text)

    /** Step two: decode `envelope.payload` once `type` has told you its shape. */
    fun <T> payload(envelope: Envelope, serializer: KSerializer<T>): T =
        json.decodeFromJsonElement(serializer, envelope.payload)

    /**
     * Full decode of one inbound frame. Returns null if the frame is not valid
     * JSON or not an envelope at all — the caller logs and drops it.
     */
    fun decode(text: String): ServerEvent? {
        val envelope = runCatching { decodeEnvelope(text) }.getOrNull() ?: return null
        if (envelope.payload !is JsonObject) return ServerEvent.Unhandled(envelope)
        return runCatching {
            when (envelope.type) {
                MessageType.HELLO_ACK ->
                    ServerEvent.HelloAck(payload(envelope, HelloAckPayload.serializer()))

                MessageType.REGISTERED ->
                    ServerEvent.Registered(payload(envelope, RegisteredPayload.serializer()))

                MessageType.OFFER ->
                    ServerEvent.Offer(envelope.from, payload(envelope, OfferPayload.serializer()))

                MessageType.ICE_CANDIDATE ->
                    ServerEvent.IceCandidate(
                        envelope.from,
                        payload(envelope, IceCandidatePayload.serializer()),
                    )

                MessageType.SESSION_END ->
                    ServerEvent.SessionEnd(
                        envelope.from,
                        payload(envelope, SessionEndPayload.serializer()),
                    )

                MessageType.ERROR ->
                    ServerEvent.Failure(payload(envelope, ErrorPayload.serializer()))

                else -> ServerEvent.Unhandled(envelope)
            }
        }.getOrElse { ServerEvent.Unhandled(envelope) }
    }
}
