# WebRTC — hardware-dependent assumptions (blind implementation)

This pipeline was implemented **without a phone**, against the exact source shipped in this repo:
ws-scrcpy **0.9.0-dev**, scrcpy-server **1.19-ws7** (`resources/ws-scrcpy/vendor/Genymobile/scrcpy/
scrcpy-server.jar`). The **codec plumbing is unit-tested** (`npm run test:rtp`, 42 checks). Everything
below could only be confirmed on the owner's host — each row says which **`npm run webrtc-diagnose`**
line (or browser stat) confirms or refutes it. WebRTC is **OFF by default**; the fleet stays legacy.

| # | Assumption | Where in code | Confirmed by | If wrong |
|---|---|---|---|---|
| A1 | **scrcpy 1.19-ws7 launch args** are positional: `app_process / …Server 1.19-ws7 web <bitrate> <maxFps> <maxSize> true - true <scid>`. This is the least-certain part — NetrisTV's "ws" fork changed the CLI. | `src/webrtc.js startCapture()` | diagnostic `scrcpy server start: PASS` + `H264 data received: PASS`. FAIL with a scrcpy stderr = wrong args. | Read the real args from `resources/ws-scrcpy/index.js` (search `app_process`) and reorder; usually a 1-line fix. |
| A2 | **Socket handshake** = 1 dummy byte + 64-byte device name, then the video stream (scrcpy 1.x). | `startCapture onData()` (`gotHeader`) | `H264 data received: PASS` and `SPS/PPS detected: PASS`. If bytes arrive but no SPS, the header offset is off. | Adjust the skipped prefix length; the ws7 fork may omit the dummy byte or change the name length. |
| A3 | **Frame-meta framing** = `[8B PTS][4B length][payload]` per packet (`send_frame_meta=true`), top PTS bit = config packet. | `startCapture onData()` frame loop | `estimated FPS` ≈ real fps and `H264 bitrate` ≈ configured. Garbage lengths/huge frames = framing mismatch. | ws7 may use a different meta size/endianness; realign the 12-byte header parse. |
| A4 | **The bundled jar runs standalone** via `app_process` with the same `CLASSPATH` push ws-scrcpy uses. | `bundledJar()` + push | `scrcpy server start: PASS`. A ClassNotFound/`app_process` error refutes it. | Match ws-scrcpy's exact push path / `scid` socket name (`resources/ws-scrcpy/index.js`). |
| A5 | **werift advertises H.264** in the SDP and negotiates PT 96 with browsers. | `_open()` `codecs.video H264` | browser overlay shows `codec H264`; agent log `pc=connected`. If SDP has no H264 line, negotiation fails. | Set the H264 profile-level-id explicitly (`42e01f`, constrained baseline) in the codec params. |
| A6 | **`track.writeRtp(Buffer)`** accepts a raw RTP packet and forwards it (SSRC/seq honored as sent). | `_open()` `track.writeRtp(pkt)` | browser `bytesReceived > 0` + `framesDecoded > 0`. bytesSent>0 but framesDecoded=0 = RTP shape/PT mismatch. | werift may want an `RtpPacket` object or its own H264 payloader — swap `packetize()` for werift's payloader (kept modular for this). |
| A7 | **Android/MediaCodec emits Annex-B** with SPS+PPS at/with each IDR; re-sending cached SPS/PPS on keyframes lets late joiners decode. | `_open() onNalUnits` lastConfig | browser decodes within ~1 keyframe interval on connect. Long green/gray = SPS/PPS timing. | Force periodic IDR (scrcpy has no repeat-headers knob at 1.19; may need a client PLI → we already advertise nack/pli). |
| A8 | **`adb forward tcp:<port> localabstract:<scid>`** reaches the scrcpy socket the ws7 server opens. | `startCapture` forward | `video socket: PASS`. Connection refused = wrong socket name/mode. | The ws7 server may use `tunnel_forward`/reverse differently; align with `resources/ws-scrcpy/index.js`. |

## Fastest path to confirm/refute all of the above
On the owner host: `npm install` then `WEBRTC_TEST_DEVICE=<serial> npm run webrtc-diagnose`. That one
command exercises A1–A4 and A7 (SPS/PPS/IDR/bitrate/fps) and needs **no** backend, browser, TURN, or
fleet change. A5/A6/A8 are confirmed by the first real browser session (WebRTC stats overlay). Paste
the diagnostic output back and the likely fix for any failing row is a small, localized change here —
not an architecture change.

## H.265 path (added 2026-10-20) — also implemented without a phone

The H.265 path uses a DIFFERENT server: upstream **scrcpy-server 5.0.1** (`resources/scrcpy/`), launched
by `src/scrcpy-capture.js` with `key=value` options (`video_codec=h265 …`). The wire protocol was read
from the 5.0.1 sources (`DesktopConnection.java`, `Streamer.java`, `SurfaceEncoder.java`), not inferred
from ws-scrcpy, so it is far less speculative than A1–A4 — but still unconfirmed on hardware.
`npm run webrtc-diagnose -- --codec both` exercises all of it.

| # | Assumption | Where in code | Confirmed by | If wrong |
|---|---|---|---|---|
| B1 | **5.0.1 launch**: `app_process / com.genymobile.scrcpy.Server 5.0.1 scid=… video_codec=h265 audio=false control=false tunnel_forward=true send_*=true …`; the first arg must equal the jar's version string. | `scrcpy-capture.js startCapture()` | `scrcpy server start: PASS` for H.265. A version-mismatch error on stderr (`server said:`) = jar/arg drift. | Re-download the matching jar (`SERVER_VERSION`) and keep both in step. |
| B2 | **Socket handshake** = 1 dummy byte, 64-byte device name, u32 codec id (`0x68323635` = "h265"), then 12-byte records. Codec id 0/1 means "stream disabled"/"config error". | `onData()` stages 0–3 | `video socket: PASS (WxH)` + `H265 data received: PASS`. A `config error` = the phone has no HEVC encoder or refused the size/bitrate. | Check the `VIDEO ENCODERS` list; try `video_encoder=<name>` or a smaller `max_size`. |
| B3 | **Record framing**: session record when byte 0 has its top bit set (flags/width/height, no payload); media record otherwise (bit 62 = config, bit 61 = key frame, then u32 size + payload). | `onData()` record loop | `VPS/SPS/PPS detected: PASS` and `IRAP detected: PASS`; `estimated FPS` ≈ real. Garbage sizes = framing off by a record. | Compare against `Streamer.java` at the exact tag; the layout changed in 4.x (session records are new). |
| B4 | **MediaCodec HEVC output is Annex-B** with VPS+SPS+PPS in one config packet before the first IRAP; re-sending them with every IRAP lets a late joiner decode. | `webrtc.js startH265()` `lastConfig` | Browser overlay shows `codec H265` and `framesDecoded` climbing within one keyframe interval (10 s at scrcpy's default I-frame interval). | Lower the I-frame interval via `video_codec_options=i-frame-interval:2`, or honour PLI by restarting the encoder. |
| B5 | **Browser negotiates H.265** from our fmtp (`profile-id=1;tier-flag=0;level-id=120;tx-mode=SRST`). Chrome ≥ 136 does so only where it has a hardware HEVC decoder; Edge does not advertise H.265 at all. | `webrtc.js codecParams()` | Agent log `negotiated H.265 (pt N)`. `negotiated H.264 … browser declined H.265` means that VA's browser can't decode it — not a bug, the fallback working. | Nothing to fix in the agent; it is per-VA-machine. Check `chrome://gpu` → "Video Decode" for HEVC. |

Everything on the RTP side (FU type 49, S/E bits, marker placement, 2-byte payload header with the
NAL's LayerId/TID copied through) is pinned by `tools/test_h265_rtp.js` and proven against ffmpeg's
independent RFC 7798 implementation by `tools/rtp-ffmpeg-check.js` (180/180 frames decoded).
