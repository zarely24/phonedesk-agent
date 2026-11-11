'use strict';
// v0.5.18 - read a phone screenshot (PNG from `screencap -p`) without any image library, to find
// Instagram's big blue button when uiautomator cannot read the screen. Pure; tested in
// tools/test_igpost.js. Handles what screencap writes: 8-bit RGBA or RGB, not interlaced.
const zlib = require('zlib');

function decode(buf) {
  if (!buf || buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  let off = 8, w = 0, h = 0, depth = 0, ctype = 0, inter = 0;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('latin1', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); depth = data[8]; ctype = data[9]; inter = data[12]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (!w || !h || depth !== 8 || inter !== 0 || (ctype !== 6 && ctype !== 2)) return null;
  const bpp = ctype === 6 ? 4 : 3, stride = w * bpp;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0, b = y ? px[dst - stride + x] : 0, c = y && x >= bpp ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[dst + x] = v & 255;
    }
  }
  return { w, h, bpp, px };
}

const isBlue = (r, g, b) => b >= 200 && r <= 130 && g >= 60 && g <= 175 && b - r >= 100;

/** The centre {x, y} (screen pixels) of the widest solid blue band in the upper 60 % of the screen:
    at least 25 % of the width and 1.5 % of the height tall. null when there is none. */
function primaryButton(png) {
  const im = decode(png);
  if (!im) return null;
  const { w, h, bpp, px } = im;
  const rows = [];
  for (let y = Math.floor(h * 0.08); y < Math.floor(h * 0.6); y++) {
    // the button's span on this row: first to last blue pixel, letting the white words inside it
    // ("Use audio") break the run; mostly blue across that span, or it is not one button
    let first = -1, last = -1, count = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * bpp;
      if (isBlue(px[i], px[i + 1], px[i + 2])) { if (first < 0) first = x; last = x; count++; }
    }
    const best = first >= 0 && count >= (last - first + 1) * 0.55 ? { from: first, len: last - first + 1 } : null;
    rows.push(best && best.len >= w * 0.25 ? { y, ...best } : null);
  }
  let band = null, cur = null;
  for (const r of rows.concat([null])) {
    if (r && cur && Math.abs(r.from - cur.from) < w * 0.03) { cur.y2 = r.y; cur.len = Math.max(cur.len, r.len); continue; }
    if (cur && cur.y2 - cur.y1 + 1 >= h * 0.015 && (!band || cur.len > band.len)) band = cur;
    cur = r ? { y1: r.y, y2: r.y, from: r.from, len: r.len } : null;
  }
  return band ? { x: Math.round(band.from + band.len / 2), y: Math.round((band.y1 + band.y2) / 2) } : null;
}

module.exports = { decode, primaryButton, isBlue };
