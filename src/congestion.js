'use strict';
/**
 * Congestion governor for ONE video tunnel (local ws-scrcpy -> backend), v0.5.8.
 *
 * WHY THIS EXISTS. The phone encodes at whatever bitrate the viewer's page asked for; the agent
 * forwards every frame into its WebSocket to the backend; the backend forwards every frame to the
 * viewer. Nothing in that path ever dropped a frame. So when the farm's upload could not carry what
 * the phones were producing - a Starlink dip, one more viewer than the budget assumed, a keyframe
 * burst - the frames did not get smaller, they QUEUED: in this process's socket buffer, then in the
 * kernel's. The viewer saw the picture freeze, then fast-forward, then freeze again, and the lag
 * only grew until something reconnected. VAs reloaded the page a hundred times an hour to "fix" it.
 *
 * WHAT IT DOES. It watches how much of this tunnel's video is still waiting to leave this computer
 * (`bufferedAmount`, plus a ws ping whose pong is delayed by everything queued in front of it, which
 * is the only way to see the kernel's buffer). When the wait crosses a threshold the governor stops
 * forwarding video - the viewer's picture simply holds still - and lets the queue drain. Once it has,
 * it asks the phone for a fresh keyframe (by replaying the viewer's own stream-settings command with
 * the bitrate nudged by one bit per second, which makes ws-scrcpy's server restart the encoder) and
 * resumes from that keyframe. Net effect: a one-second still picture instead of ten seconds of
 * growing lag, and the stream comes back with ZERO accumulated delay.
 *
 * It does NOT decide bitrates. It tells the backend "this computer is congested" (AgentCore sends
 * the `congestion` op) and the backend lowers that computer's budget, which the stream pages follow.
 * Two controllers fighting over the encoder would oscillate; one controller plus a safety valve does
 * not. Everything here is pure and synchronous on purpose: it runs on the relay's event loop for
 * every frame, so it must cost nothing and never await.
 */

const TYPE_CHANGE_STREAM_PARAMETERS = 101;
const SETTINGS_MSG_LEN = 36;             // 1 type byte + VideoSettings.toBuffer() 35-byte payload

// H.264 NAL unit types that let a decoder (re)start cleanly.
const NAL_IDR = 5, NAL_SPS = 7, NAL_PPS = 8;

function toU8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;                           // strings (JSON device messages) are never video
}

/** ws-scrcpy's server sends raw Annex-B H.264: every video message begins with a start code.
    Device messages begin with the ASCII magic "scrcpy_message" and JSON ones are text. */
function isVideoFrame(u8) {
  if (!u8 || u8.length < 5 || u8[0] !== 0 || u8[1] !== 0) return false;
  return u8[2] === 1 || (u8[2] === 0 && u8[3] === 1);
}

/** Every NAL type in the message (a message is usually one NAL, but be safe and scan). */
function nalTypes(u8) {
  const out = [];
  const n = u8.length;
  for (let i = 0; i + 3 < n; i++) {
    if (u8[i] === 0 && u8[i + 1] === 0) {
      if (u8[i + 2] === 1 && i + 3 < n) { out.push(u8[i + 3] & 31); i += 3; }
      else if (u8[i + 2] === 0 && u8[i + 3] === 1 && i + 4 < n) { out.push(u8[i + 4] & 31); i += 4; }
    }
  }
  return out;
}

/** A frame a decoder can resume from after we dropped some: SPS/PPS (the restarted encoder's
    parameter sets) or an IDR picture. Everything else is a P-frame that is garbage without its
    predecessors. */
function isResyncFrame(u8) {
  const types = nalTypes(u8);
  for (let i = 0; i < types.length; i++) {
    if (types[i] === NAL_IDR || types[i] === NAL_SPS || types[i] === NAL_PPS) return true;
  }
  return false;
}

/** The viewer's stream-settings command, if this viewer->phone message is one. We keep a copy so
    we can ask the encoder for a keyframe later. The type byte sits 36 from the end (the page uses
    the same rule - see backend/web/stream/index.html, capture()). */
function captureSettingsFrame(data) {
  const a = toU8(data);
  if (!a || a.length < SETTINGS_MSG_LEN) return null;
  if (a[a.length - SETTINGS_MSG_LEN] !== TYPE_CHANGE_STREAM_PARAMETERS) return null;
  return a.slice();
}

function i32(a, o) { return ((a[o] << 24) | (a[o + 1] << 16) | (a[o + 2] << 8) | a[o + 3]) >>> 0; }
function put32(a, o, v) { a[o] = (v >>> 24) & 255; a[o + 1] = (v >>> 16) & 255; a[o + 2] = (v >>> 8) & 255; a[o + 3] = v & 255; }

/** A copy of the captured settings command with the bitrate lowered by 1 or 2 bit/s (alternating,
    so two forces in a row still differ from each other). ws-scrcpy's server restarts the encoder
    whenever the settings CHANGE, and a restart begins with SPS/PPS/IDR - the keyframe we need. A
    difference of one bit per second is invisible in the picture. Returns an ArrayBuffer ready to
    send, or null if the captured frame is unusable. */
function forceKeyframeMessage(captured, n) {
  if (!captured || captured.length < SETTINGS_MSG_LEN) return null;
  const out = captured.slice();
  const base = out.length - SETTINGS_MSG_LEN + 1;
  const bitrate = i32(out, base);
  if (bitrate < 1000) return null;       // not a sane bitrate; refuse to send nonsense to the phone
  put32(out, base, bitrate - 1 - ((n | 0) & 1));
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

const DEFAULTS = {
  highBytes: 96 * 1024,    // queued video beyond this = congested, whatever the rate says
  highMs: 600,             // ...or more than this much of the stream waiting to leave
  lowBytes: 24 * 1024,     // the queue must fall back under BOTH of these before we resume
  lowMs: 200,
  pongHighMs: 800,         // a pong this late (above the baseline) means the kernel is holding frames
  forceEveryMs: 1500,      // never ask the phone for keyframes faster than this
  rateWindowMs: 2000,      // the incoming byte rate is measured over this window
  minDropMs: 150,          // once dropping, hold at least this long (lets a burst clear before judging)
};

class TunnelGovernor {
  constructor(opts) {
    this.o = Object.assign({}, DEFAULTS, opts || {});
    this.dropping = false;
    this.events = 0;             // times we entered congestion
    this.droppedFrames = 0;
    this.droppedBytes = 0;
    this.maxQueueMs = 0;
    this.enteredAt = 0;
    this.lastForceAt = 0;
    this.forces = 0;
    this._bytes = [];            // [time, len] of incoming video, for the rate estimate
    this._bytesSum = 0;
    this._pingSentAt = null;     // null = no ping outstanding (a timestamp of 0 is legal in tests)
    this._pongBase = null;       // best (lowest) pong time seen = the path's real RTT
    this._pongLag = 0;           // latest pong time above that baseline
  }

  _recordBytes(len, now) {
    this._bytes.push([now, len]);
    this._bytesSum += len;
    const cutoff = now - this.o.rateWindowMs;
    while (this._bytes.length && this._bytes[0][0] < cutoff) this._bytesSum -= this._bytes.shift()[1];
  }

  /** Incoming video rate, bytes per second, over the last rateWindowMs. */
  rateBps(now) {
    if (this._bytes.length < 2) return 0;
    const span = Math.max(250, now - this._bytes[0][0]);
    return this._bytesSum * 1000 / span;
  }

  /** How long the bytes still queued would take to leave at the rate they are arriving - i.e. the
      delay the viewer is about to see. 0 when nothing is queued or we cannot tell. */
  queueMs(bufferedAmount, now) {
    const b = Number(bufferedAmount) || 0;
    if (b <= 0) return 0;
    const r = this.rateBps(now);
    return r > 0 ? b * 1000 / r : 0;
  }

  // ---- ws ping/pong: the only view into the kernel's send buffer --------------------------------
  pingDue() { return this._pingSentAt === null; }
  onPingSent(now) { this._pingSentAt = now; }
  onPong(now) {
    if (this._pingSentAt === null) return;
    const t = now - this._pingSentAt;
    this._pingSentAt = null;
    this._pongBase = this._pongBase === null ? t : Math.min(this._pongBase, t);
    this._pongLag = Math.max(0, t - this._pongBase);
  }
  /** Lag now: the last measured one, or - if a ping is still unanswered - at least how long it has
      been waiting, so a pong that never comes back still reads as congestion. */
  pongLagMs(now) {
    if (this._pingSentAt !== null && this._pongBase !== null) {
      return Math.max(this._pongLag, now - this._pingSentAt - this._pongBase);
    }
    return this._pongLag;
  }

  congested(bufferedAmount, now) {
    const b = Number(bufferedAmount) || 0;
    return b > this.o.highBytes || this.queueMs(b, now) > this.o.highMs || this.pongLagMs(now) > this.o.pongHighMs;
  }
  relieved(bufferedAmount, now) {
    const b = Number(bufferedAmount) || 0;
    return b < this.o.lowBytes && this.queueMs(b, now) < this.o.lowMs && this.pongLagMs(now) < this.o.pongHighMs / 2;
  }

  _canForce(now) {
    if (now - this.lastForceAt < this.o.forceEveryMs) return false;
    this.lastForceAt = now;
    this.forces++;
    return true;
  }

  /**
   * One incoming video message. `isResync` is a function (so the scan only runs when it matters).
   * Returns { send, force, entered, left }: forward it or not; ask the phone for a keyframe now;
   * and whether this frame is the moment we entered / left congestion (for logging + reporting).
   */
  onVideo(len, bufferedAmount, isResync, now) {
    this._recordBytes(len, now);
    const q = this.queueMs(bufferedAmount, now);
    if (q > this.maxQueueMs) this.maxQueueMs = q;
    if (!this.dropping) {
      if (!this.congested(bufferedAmount, now)) return { send: true, force: false, entered: false, left: false };
      this.dropping = true;
      this.events++;
      this.enteredAt = now;
      this.droppedFrames++; this.droppedBytes += len;
      return { send: false, force: false, entered: true, left: false };
    }
    // Dropping. Resume only on a frame a decoder can start from, and only once the queue is gone -
    // resuming into a still-full queue would just rebuild the lag we are trying to shed.
    const ready = now - this.enteredAt >= this.o.minDropMs && this.relieved(bufferedAmount, now);
    if (ready && isResync()) {
      this.dropping = false;
      return { send: true, force: false, entered: false, left: true };
    }
    this.droppedFrames++; this.droppedBytes += len;
    // Queue drained but no keyframe in sight (the next natural one may be 20 s away): ask for one.
    const force = ready && this._canForce(now);
    return { send: false, force, entered: false, left: false };
  }

  /** For the heartbeat / dashboard. */
  stats(now) {
    return {
      dropping: this.dropping,
      events: this.events,
      dropped_frames: this.droppedFrames,
      dropped_bytes: this.droppedBytes,
      max_queue_ms: Math.round(this.maxQueueMs),
      pong_lag_ms: Math.round(this.pongLagMs(now || Date.now())),
      rtt_ms: this._pongBase === null ? null : Math.round(this._pongBase),
      forces: this.forces,
    };
  }
}

module.exports = {
  TunnelGovernor, DEFAULTS, toU8, isVideoFrame, nalTypes, isResyncFrame,
  captureSettingsFrame, forceKeyframeMessage, TYPE_CHANGE_STREAM_PARAMETERS, SETTINGS_MSG_LEN,
};
