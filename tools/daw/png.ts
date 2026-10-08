import { deflateSync } from 'node:zlib';
import type { Image } from '../../src/daw/raster';

/** PNG のバイト列にする (圧縮あり・フィルタなし)。 */
export function toPng(img: Image): Uint8Array {
  const raw = new Uint8Array((img.w * 4 + 1) * img.h);
  for (let y = 0; y < img.h; y++) raw.set(img.data.subarray(y * img.w * 4, (y + 1) * img.w * 4), y * (img.w * 4 + 1) + 1);
  const z = deflateSync(raw);
  const chunks = [chunk('IHDR', ihdr(img.w, img.h)), chunk('IDAT', z), chunk('IEND', new Uint8Array(0))];
  const sig = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = new Uint8Array(sig.length + chunks.reduce((s, c) => s + c.length, 0));
  out.set(sig, 0);
  let o = sig.length;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function ihdr(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  const v = new DataView(b.buffer);
  v.setUint32(0, w);
  v.setUint32(4, h);
  b[8] = 8; // 1 色 8 ビット
  b[9] = 6; // RGBA
  return b;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  v.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}
