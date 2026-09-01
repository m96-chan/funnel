# Minification is off in every build type today, so this file is a placeholder.
#
# When release minification is turned on, libwebrtc's JNI entry points are the
# first thing that will break — it calls back into Java by name:
#
# -keep class org.webrtc.** { *; }
#
# kotlinx.serialization keeps its own generated serializers via the consumer
# rules shipped in the artifact; nothing extra is needed here.
