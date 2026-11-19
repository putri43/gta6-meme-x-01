// gta6-meme-x-01 — "Florida Man Was Born Ready"
//
// A GTA 6 meme generator for the make.fun "Post a GTA 6 meme on X" bounty.
// It draws the whole picture procedurally with the Node standard library only:
// a Vice City sunset, palm trees, a pink convertible, and the make.fun ghost
// dressed as a Florida Man (sunglasses up on its forehead, a flower lei, a
// magenta star coin in its little hand), under the joke that GTA 6 is set in
// Florida — so Florida Man was born ready. No network, no downloaded assets,
// no installs. The output is fully deterministic: the same bytes every run.
//
// It also copies POST.json from the repository root to the output directory,
// which is what the entry gate reads. POST.json names the X post; until the
// user posts the meme from their phone it holds a placeholder address.
//
// Run it locally with:
//   mkdir -p out && MAKEFUN_BOT_DIR=. MAKEFUN_OUTPUT_DIR=out node main.ts

import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';

const W = 1080;
const H = 1080;

type RGB = [number, number, number];

// ---------------------------------------------------------------------------
// Pixel buffer
// ---------------------------------------------------------------------------

const px = new Uint8Array(W * H * 4);

function setPx(x: number, y: number, c: RGB): void {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (ix < 0 || iy < 0 || ix >= W || iy >= H) return;
  const o = (iy * W + ix) * 4;
  px[o] = c[0];
  px[o + 1] = c[1];
  px[o + 2] = c[2];
  px[o + 3] = 255;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function mix(c1: RGB, c2: RGB, t: number): RGB {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

function fillRect(x: number, y: number, w: number, h: number, c: RGB): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(W, Math.ceil(x + w));
  const y1 = Math.min(H, Math.ceil(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      setPx(xx, yy, c);
    }
  }
}

// Vertical gradient band: stops are [position 0..1, colour].
function fillGradient(
  x: number,
  y: number,
  w: number,
  h: number,
  stops: Array<[number, RGB]>,
): void {
  for (let yy = 0; yy < Math.ceil(h); yy++) {
    const t = h <= 1 ? 0 : yy / (h - 1);
    let c = stops[stops.length - 1][1];
    for (let s = 0; s < stops.length - 1; s++) {
      const [t0, c0] = stops[s];
      const [t1, c1] = stops[s + 1];
      if (t >= t0 && t <= t1) {
        c = mix(c0, c1, t1 === t0 ? 0 : (t - t0) / (t1 - t0));
        break;
      }
      if (t < t0) {
        c = c0;
        break;
      }
    }
    fillRect(x, y + yy, w, 1, c);
  }
}

function fillCircle(cx: number, cy: number, r: number, c: RGB): void {
  const rr = Math.floor(r);
  for (let dy = -rr; dy <= rr; dy++) {
    const dx = Math.floor(Math.sqrt(Math.max(0, r * r - dy * dy)));
    for (let xx = -dx; xx <= dx; xx++) {
      setPx(cx + xx, cy + dy, c);
    }
  }
}

function fillEllipse(cx: number, cy: number, rx: number, ry: number, c: RGB): void {
  const rxi = Math.floor(rx);
  const ryi = Math.floor(ry);
  for (let dy = -ryi; dy <= ryi; dy++) {
    const t = 1 - (dy * dy) / (ry * ry);
    if (t < 0) continue;
    const dx = Math.floor(rx * Math.sqrt(t));
    for (let xx = -dx; xx <= dx; xx++) {
      setPx(cx + xx, cy + dy, c);
    }
  }
}

// Scanline polygon fill (even-odd), points as [x, y] pairs.
function fillPolygon(points: Array<[number, number]>, c: RGB): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(H - 1, Math.ceil(maxY)); y++) {
    const xs: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x0, y0] = points[i];
      const [x1, y1] = points[(i + 1) % points.length];
      if ((y0 <= y && y1 > y) || (y1 <= y && y0 > y)) {
        xs.push(x0 + ((y - y0) * (x1 - x0)) / (y1 - y0));
      }
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const xa = Math.max(0, Math.ceil(xs[k]));
      const xb = Math.min(W - 1, Math.floor(xs[k + 1]));
      for (let x = xa; x <= xb; x++) setPx(x, y, c);
    }
  }
}

// A thick line, drawn as a chain of circles.
function thickLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  w: number,
  c: RGB,
): void {
  const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    fillCircle(lerp(x0, x1, t), lerp(y0, y1, t), w / 2, c);
  }
}

// A regular star polygon (5 points by default) as a point list.
function starPoints(
  cx: number,
  cy: number,
  rOuter: number,
  rInner: number,
  points = 5,
  rot = -Math.PI / 2,
): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? rOuter : rInner;
    const a = rot + (i * Math.PI) / points;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// PNG encoding (pure stdlib: zlib for IDAT, hand-rolled CRC32)
// ---------------------------------------------------------------------------

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // One filter byte (0 = None) per scanline, then the raw RGBA row.
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    raw.set(px.subarray(y * W * 4, (y + 1) * W * 4), y * (1 + W * 4) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Bitmap font: 5x7 glyphs, drawn as blocks. '#' is on, '.' is off.
// A chunky pixel face fits a meme and stays readable when the picture is
// shrunk to feed size.
// ---------------------------------------------------------------------------

const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00110', '01000', '10000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['01110', '10000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00001', '01110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
  '.': ['00000', '00000', '00000', '00000', '00000', '01100', '01100'],
  ',': ['00000', '00000', '00000', '00000', '01100', '00100', '01000'],
  '!': ['00100', '00100', '00100', '00100', '00100', '00000', '00100'],
  '?': ['01110', '10001', '00001', '00110', '00100', '00000', '00100'],
  ':': ['00000', '01100', '01100', '00000', '01100', '01100', '00000'],
  "'": ['00100', '00100', '01000', '00000', '00000', '00000', '00000'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  '/': ['00001', '00010', '00010', '00100', '01000', '01000', '10000'],
  '(': ['00010', '00100', '01000', '01000', '01000', '00100', '00010'],
  ')': ['01000', '00100', '00010', '00010', '00010', '00100', '01000'],
  '&': ['01100', '10010', '10100', '01000', '10101', '10010', '01101'],
};

const GLYPH_W = 5;
const GLYPH_H = 7;
const GLYPH_ADVANCE = 6; // 5 pixels + 1 pixel of tracking

function textWidth(text: string, scale: number): number {
  if (text.length === 0) return 0;
  return (text.length * GLYPH_ADVANCE - 1) * scale;
}

// Draw one line of text, centred on cx, top edge at y.
function drawText(
  text: string,
  cx: number,
  y: number,
  scale: number,
  color: RGB,
): void {
  const total = textWidth(text, scale);
  let x = Math.round(cx - total / 2);
  for (const ch of text) {
    const glyph = FONT[ch] ?? FONT['?'];
    for (let row = 0; row < GLYPH_H; row++) {
      for (let col = 0; col < GLYPH_W; col++) {
        if (glyph[row][col] === '1') {
          fillRect(x + col * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    x += GLYPH_ADVANCE * scale;
  }
}

// ---------------------------------------------------------------------------
// The make.fun ghost, drawn in code: white body with a thick black outline,
// two black four-pointed sparkle eyes, a small open smile, one round little
// hand holding a magenta coin with a white star. Here it wears sunglasses
// pushed up on its forehead and a flower lei — a Florida Man on holiday.
// ---------------------------------------------------------------------------

const GHOST_WHITE: RGB = [255, 255, 255];
const INK: RGB = [12, 12, 18];
const COIN_MAGENTA: RGB = [226, 0, 122];
const COIN_DARK: RGB = [170, 0, 92];

// Ghost body outline points: dome head, straight sides, wavy hem.
// cx, top: centre x and top of the dome. w: body width, h: body height.
function ghostPoints(
  cx: number,
  top: number,
  w: number,
  h: number,
): Array<[number, number]> {
  const half = w / 2;
  const pts: Array<[number, number]> = [];
  // Dome: semicircle-ish arc from the left side over the top to the right.
  const domeR = half;
  const domeCy = top + domeR;
  for (let a = Math.PI; a >= 0; a -= Math.PI / 24) {
    pts.push([cx + domeR * Math.cos(a), domeCy - domeR * Math.sin(a)]);
  }
  // Right side down to the hem.
  const hemY = top + h;
  pts.push([cx + half, hemY - 14]);
  // Wavy hem: three scallops back to the left side.
  const waves = 3;
  const waveW = w / waves;
  for (let i = 0; i < waves; i++) {
    const x0 = cx + half - i * waveW;
    const x1 = cx + half - (i + 1) * waveW;
    const midX = (x0 + x1) / 2;
    pts.push([x0 - waveW * 0.25, hemY]);
    pts.push([midX, hemY - 22]);
    pts.push([x1 + waveW * 0.25, hemY]);
  }
  // Left side back up to the dome.
  pts.push([cx - half, hemY - 14]);
  return pts;
}

// Draw the ghost at (cx, top) with body width w and height h.
function drawGhost(cx: number, top: number, w: number, h: number): void {
  const outline = 10;
  // Thick black outline: the same shape, grown outward, drawn first.
  const big = ghostPoints(cx - outline * 0.55, top - outline, w + outline * 1.1, h + outline);
  fillPolygon(big, INK);
  const body = ghostPoints(cx, top, w, h);
  fillPolygon(body, GHOST_WHITE);

  const eyeY = top + h * 0.30;
  const eyeDX = w * 0.17;
  const eyeR = w * 0.075;
  // Four-pointed sparkle eyes.
  for (const ex of [cx - eyeDX, cx + eyeDX]) {
    fillPolygon(starPoints(ex, eyeY, eyeR, eyeR * 0.30, 4, 0), INK);
  }
  // Small open smile.
  fillEllipse(cx, top + h * 0.44, w * 0.045, h * 0.028, INK);

  // Sunglasses pushed up on the forehead, tilted like a Florida Man.
  const sgY = top + h * 0.13;
  const lensW = w * 0.17;
  const lensH = h * 0.075;
  const tilt = 0.12;
  for (const s of [-1, 1]) {
    const lx = cx + s * w * 0.16;
    const pts: Array<[number, number]> = [];
    const hw = lensW / 2;
    const hh = lensH / 2;
    const corners: Array<[number, number]> = [
      [-hw, -hh],
      [hw, -hh],
      [hw, hh],
      [-hw, hh],
    ];
    for (const [dx, dy] of corners) {
      const rx = dx * Math.cos(tilt * s) - dy * Math.sin(tilt * s);
      const ry = dx * Math.sin(tilt * s) + dy * Math.cos(tilt * s);
      pts.push([lx + rx, sgY + ry]);
    }
    fillPolygon(pts, INK);
    // Lens shine.
    fillCircle(lx - lensW * 0.18, sgY - lensH * 0.12, 3, [255, 255, 255]);
  }
  thickLine(cx - w * 0.055, sgY, cx + w * 0.055, sgY, 6, INK);

  // Flower lei around the neck.
  const leiY = top + h * 0.60;
  const leiColors: RGB[] = [
    [255, 45, 120],
    [255, 190, 60],
    [255, 255, 255],
    [120, 220, 255],
  ];
  const nFlowers = 9;
  for (let i = 0; i < nFlowers; i++) {
    const t = i / (nFlowers - 1);
    const fx = cx - w * 0.30 + t * w * 0.60;
    const fy = leiY + Math.sin(t * Math.PI) * h * 0.045;
    const fr = w * 0.035;
    fillCircle(fx, fy, fr + 2, INK);
    fillCircle(fx, fy, fr, leiColors[i % leiColors.length]);
    fillCircle(fx, fy, Math.max(2, fr * 0.35), [255, 255, 255]);
  }

  // Round little hand on the right, holding the magenta star coin.
  const hx = cx + w * 0.52;
  const hy = top + h * 0.58;
  const handR = w * 0.075;
  fillCircle(hx, hy, handR + 4, INK);
  fillCircle(hx, hy, handR, GHOST_WHITE);
  const coinR = w * 0.115;
  const coinCx = hx + w * 0.10;
  const coinCy = hy - h * 0.06;
  fillCircle(coinCx, coinCy, coinR + 3, INK);
  fillCircle(coinCx, coinCy, coinR, COIN_MAGENTA);
  fillCircle(coinCx, coinCy, coinR * 0.78, COIN_DARK);
  fillPolygon(starPoints(coinCx, coinCy, coinR * 0.62, coinR * 0.26), [255, 255, 255]);

  // Two little feet peeking under the hem.
  fillEllipse(cx - w * 0.18, top + h + 4, w * 0.075, h * 0.022, GHOST_WHITE);
  fillEllipse(cx + w * 0.18, top + h + 4, w * 0.075, h * 0.022, GHOST_WHITE);
}

// A palm tree silhouette: curved trunk, six drooping fronds.
function drawPalm(x: number, baseY: number, h: number, lean: number): void {
  const topX = x + lean;
  const topY = baseY - h;
  const trunk: RGB = [38, 16, 58];
  thickLine(x, baseY, topX, topY, 18, trunk);
  fillCircle(topX, topY, 12, trunk);
  const fronds = 6;
  for (let i = 0; i < fronds; i++) {
    const a = -Math.PI / 2 + (i - (fronds - 1) / 2) * 0.55;
    const len = h * 0.55;
    // Tip: out to the side and drooping down.
    const ex = topX + Math.cos(a) * len;
    const ey = topY + Math.sin(a) * len * 0.45 + len * 0.5;
    // Narrow tapered triangle from the crown to the tip.
    const bx = Math.cos(a + Math.PI / 2);
    const by = Math.sin(a + Math.PI / 2);
    const half = 10;
    fillPolygon(
      [
        [topX + bx * half, topY + by * half],
        [topX - bx * half, topY - by * half],
        [ex, ey],
      ],
      trunk,
    );
  }
  // Coconuts.
  fillCircle(topX - 8, topY + 8, 6, trunk);
  fillCircle(topX + 8, topY + 10, 6, trunk);
}

// A pink convertible, side view, parked on the sand.
function drawCar(x: number, y: number, w: number): void {
  const h = w * 0.30;
  const pink: RGB = [255, 77, 166];
  const dark: RGB = [20, 10, 30];
  // Body.
  fillPolygon(
    [
      [x, y + h * 0.55],
      [x + w * 0.06, y + h * 0.28],
      [x + w * 0.30, y + h * 0.18],
      [x + w * 0.62, y + h * 0.18],
      [x + w * 0.86, y + h * 0.30],
      [x + w * 0.98, y + h * 0.55],
      [x + w * 0.98, y + h * 0.78],
      [x, y + h * 0.78],
    ],
    pink,
  );
  // Cabin opening.
  fillPolygon(
    [
      [x + w * 0.32, y + h * 0.22],
      [x + w * 0.60, y + h * 0.22],
      [x + w * 0.68, y + h * 0.52],
      [x + w * 0.30, y + h * 0.52],
    ],
    dark,
  );
  // Wheels.
  for (const wx of [x + w * 0.22, x + w * 0.78]) {
    fillCircle(wx, y + h * 0.78, h * 0.20, INK);
    fillCircle(wx, y + h * 0.78, h * 0.09, [220, 220, 230]);
  }
  // Headlight.
  fillCircle(x + w * 0.95, y + h * 0.48, 5, [255, 240, 170]);
}

// Blocky skyline silhouettes with a few lit windows.
function drawSkyline(yBase: number, color: RGB): void {
  let x = 0;
  let seed = 7;
  const next = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  while (x < W + 10) {
    const bw = 46 + next() * 60;
    const bh = 40 + next() * 85;
    fillRect(x, yBase - bh, bw, bh, color);
    // A couple of lit windows.
    const wins = 1 + Math.floor(next() * 3);
    for (let i = 0; i < wins; i++) {
      const wx = x + 8 + next() * (bw - 16);
      const wy = yBase - bh + 10 + next() * (bh - 22);
      fillRect(wx, wy, 5, 7, [255, 214, 106]);
    }
    x += bw + 6 + next() * 22;
  }
}

// ---------------------------------------------------------------------------
// The scene: a Vice City sunset beach, 1080x1080.
//   top black bar    — the setup line
//   sunset scene     — sky, sun, skyline, palms, sand, pink car, the ghost
//   bottom black bar — the punchline
//   magenta strip    — the make.fun pitch
// ---------------------------------------------------------------------------

const SUNSET_TOP: RGB = [27, 16, 53];
const SUNSET_MID: RGB = [123, 45, 139];
const SUNSET_LOW: RGB = [232, 67, 147];
const SUNSET_SAND: RGB = [255, 158, 79];
const SUNSET_HORIZON: RGB = [255, 196, 107];
const SAND: RGB = [217, 160, 91];
const SAND_DARK: RGB = [190, 130, 66];
const STRIP_MAGENTA: RGB = [230, 0, 122];

function drawScene(): void {
  // Top bar.
  fillRect(0, 0, W, 150, INK);
  drawText('GTA 6 IS SET IN FLORIDA.', W / 2, 50, 7, [255, 255, 255]);

  // Sunset sky.
  fillGradient(150, 150, W, 560, [
    [0, SUNSET_TOP],
    [0.35, SUNSET_MID],
    [0.65, SUNSET_LOW],
    [0.85, SUNSET_SAND],
    [1, SUNSET_HORIZON],
  ]);
  // Sun with a glow ring.
  fillCircle(790, 600, 118, [255, 179, 71]);
  fillCircle(790, 600, 95, [255, 233, 168]);

  // Skyline, back layer then front layer.
  drawSkyline(700, [61, 28, 99]);
  drawSkyline(710, [42, 18, 69]);

  // Sand.
  fillRect(0, 700, W, 110, SAND);
  // Deterministic speckles in the sand.
  let seed = 12345;
  const next = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  for (let i = 0; i < 90; i++) {
    const sx = next() * W;
    const sy = 710 + next() * 92;
    fillCircle(sx, sy, 2, SAND_DARK);
  }

  // Palms left and right, pink car on the left.
  drawPalm(110, 800, 330, -28);
  drawPalm(975, 800, 300, 26);
  drawCar(58, 726, 300);

  // A small starfish on the sand, right side.
  fillPolygon(starPoints(880, 762, 26, 11), [255, 120, 60]);

  // The ghost, front and centre.
  drawGhost(540, 330, 320, 380);

  // Divider lines and bottom bar.
  fillRect(0, 150, W, 6, COIN_MAGENTA);
  fillRect(0, 804, W, 6, COIN_MAGENTA);
  fillRect(0, 810, W, 150, INK);
  drawText('FLORIDA MAN WAS BORN READY.', W / 2, 864, 6, [255, 255, 255]);

  // Magenta pitch strip.
  fillRect(0, 960, W, 120, STRIP_MAGENTA);
  drawText('MY AI AGENT EARNS REAL MONEY ON MAKE.FUN', W / 2, 1006, 4, [255, 255, 255]);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const BOT_DIR = process.env.MAKEFUN_BOT_DIR ?? '/bot';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

function main(): void {
  drawScene();
  const png = encodePng();

  mkdirSync(OUTPUT_DIR, { recursive: true });
  try {
    writeFileSync(join(BOT_DIR, 'meme.png'), png);
    console.log(`wrote ${join(BOT_DIR, 'meme.png')} (${png.length} bytes)`);
  } catch (err) {
    console.log(`could not write meme.png next to the code: ${(err as Error).message}`);
  }
  writeFileSync(join(OUTPUT_DIR, 'meme.png'), png);
  console.log(`wrote ${join(OUTPUT_DIR, 'meme.png')} (${png.length} bytes)`);

  try {
    copyFileSync(join(BOT_DIR, 'POST.json'), join(OUTPUT_DIR, 'POST.json'));
    console.log(`copied POST.json to ${OUTPUT_DIR}`);
  } catch (err) {
    console.error(`POST.json could not be copied from ${BOT_DIR}: ${(err as Error).message}`);
    process.exit(1);
  }
}

main();
