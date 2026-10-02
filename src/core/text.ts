/** 表示名/保存データで共通して使う文字列ユーティリティ。 */

export const NAME_MAX = 16;

/** 制御文字・改行・ゼロ幅文字・双方向制御文字を除いた、最大 16 文字の表示名。空なら fallback ('NoName')。 */
export function sanitizeName(raw: string, fallback = 'NoName'): string {
  // eslint-disable-next-line no-control-regex -- 制御文字を取り除くために意図的に使う
  const cleaned = Array.from(String(raw ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ''))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  const cut = Array.from(cleaned).slice(0, NAME_MAX).join('').trim();
  return cut || fallback;
}

/** FNV-1a (32bit) の 16 進 8 桁。改ざん防止ではなく、破損の検出/ビルドの目印に使う。 */
export function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
