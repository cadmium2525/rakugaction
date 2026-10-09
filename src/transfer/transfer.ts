import { fail, ok } from '../ranking/types';
import type { RankingResult } from '../ranking/types';

/**
 * データの引き継ぎ (引き継ぎコード)。docs/TRANSFER.md。
 *
 *  元の端末: セーブデータ + ランキングの匿名 ID (本人のしるし) を、圧縮して Firebase に一時的に預け、12 文字のコードを出す
 *  新しい端末: コードを入れる → 受け取る → 「今のデータは消えます」を確かめる → セーブを書き、匿名 ID を引き継ぎ、預けた物を消す
 *
 * 決まり (ユーザーの決定, 2026-10-09): コード方式だけ・ランキングの記録の持ち主も引き継ぐ・元の端末のデータは残す・受け取る側のデータは上書き。
 * 安全のために: コードは 12 文字 (31 種類の文字 → 約 8×10^17 通り)・24 時間で無効・受け取ったら消す (1 回きり)・一覧は誰も読めない (firestore.rules)。
 * **コードは、ランキングの記録の持ち主になれる鍵を含む物への合い言葉**: 人に見せない、という注意を画面に出す。
 */

/** コードに使う文字 (まぎらわしい 0 / O / 1 / I / L を除いた 31 種類) */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 12;
/** コードが使える時間 (ms) */
export const TRANSFER_TTL_MS = 24 * 60 * 60 * 1000;
/** 預ける 1 件の文字数の上限 (Firestore の 1 件は 1MiB まで) と、分ける数の上限 */
export const CHUNK_CHARS = 900_000;
export const MAX_PARTS = 8;

/** 新しいコードを作る (暗号用の乱数)。 */
export function generateCode(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let out = '';
  // 31 で割り切れない端を捨てて、かたよりを無くす (248 = 31 × 8 未満だけ使う)
  while (out.length < CODE_LENGTH) {
    for (const b of random(CODE_LENGTH * 2)) {
      if (b < 248 && out.length < CODE_LENGTH) out += CODE_ALPHABET[b % 31];
    }
  }
  return out;
}

/** 入力されたコードを整える (小文字 → 大文字・空白やハイフンを除く)。形が合わなければ null。 */
export function normalizeCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[^0-9A-Z]/g, '');
  if (s.length !== CODE_LENGTH) return null;
  for (const c of s) if (!CODE_ALPHABET.includes(c)) return null;
  return s;
}

/** 画面に出す形 (4 文字ずつ、ハイフンで区切る)。 */
export function formatCode(code: string): string {
  return code.replace(/(.{4})(?=.)/g, '$1-');
}

/** 預ける中身 */
export interface TransferPayload {
  v: 1;
  /** セーブデータ (serializeSave の JSON 文字列。受け取る側は parseSave で検査する) */
  save: string;
  /** ランキングの匿名 ID (持ち主のしるし)。無ければ null (ランキングを使ったことがない・未設定) */
  auth: { uid: string; refresh: string } | null;
}

const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string): Uint8Array => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function pipe(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<BufferSource> }): Promise<Uint8Array> {
  const w = stream.writable.getWriter();
  void w.write(bytes as BufferSource).then(() => w.close());
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

/**
 * 中身を、預ける文字列の並びにする: JSON → gzip → base64 → 90 万文字ずつに分ける。
 * 先頭の 1 文字は形式 ('g' = gzip / 'r' = 圧縮なし。圧縮の機能が無い古いブラウザ用)。大きすぎる時は null。
 */
export async function packPayload(p: TransferPayload): Promise<string[] | null> {
  const json = JSON.stringify(p);
  let text: string;
  if (typeof CompressionStream === 'function') {
    text = 'g' + b64(await pipe(new TextEncoder().encode(json), new CompressionStream('gzip') as never));
  } else {
    text = 'r' + b64(new TextEncoder().encode(json));
  }
  const parts: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));
  return parts.length > MAX_PARTS ? null : parts;
}

/** 預けた文字列の並び → 中身。壊れている・形が合わない時は null。 */
export async function unpackPayload(parts: readonly string[]): Promise<TransferPayload | null> {
  try {
    const text = parts.join('');
    const body = unb64(text.slice(1));
    let bytes: Uint8Array;
    if (text[0] === 'g') {
      if (typeof DecompressionStream !== 'function') return null;
      bytes = await pipe(body, new DecompressionStream('gzip') as never);
    } else if (text[0] === 'r') bytes = body;
    else return null;
    const raw = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TransferPayload> | null;
    if (!raw || raw.v !== 1 || typeof raw.save !== 'string') return null;
    const a = raw.auth;
    const auth = a && typeof a.uid === 'string' && typeof a.refresh === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(a.uid) && a.refresh.length > 0 && a.refresh.length < 4096 ? { uid: a.uid, refresh: a.refresh } : null;
    return { v: 1, save: raw.save, auth };
  } catch {
    // base64・gzip・JSON のどれかが壊れている: 読めないコードとして扱う
    return null;
  }
}

/** 預け先 (Firestore、または、テスト用のメモリ) */
export interface TransferBackend {
  /** 預ける。parts[0] を id、parts[i] を `id-i` に書く。owner = 預けた人の匿名 ID */
  put(id: string, parts: readonly string[], expiresAt: number): Promise<RankingResult<true>>;
  /** 受け取る (分かれている分も全部)。無い・期限切れは rejected */
  get(id: string): Promise<RankingResult<string[]>>;
  /** 消す (受け取ったあと。失敗しても、24 時間で無効になる) */
  remove(id: string, parts: number): Promise<void>;
}

/** ランキングの匿名 ID を出し入れする口 (FirestoreRankingBackend が実装する) */
export interface IdentityPort {
  exportIdentity(): Promise<{ uid: string; refresh: string } | null>;
  adoptIdentity(uid: string, refresh: string): void;
}

export interface Received {
  code: string;
  parts: number;
  payload: TransferPayload;
}

export class TransferService {
  constructor(
    private readonly backend: TransferBackend | null,
    private readonly identity: IdentityPort | null,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** 引き継ぎが使えるか (Firebase の設定がある時だけ) */
  get available(): boolean {
    return this.backend !== null;
  }

  /** 元の端末: セーブデータを預けて、コードを返す。 */
  async create(saveJson: string): Promise<RankingResult<{ code: string; expiresAt: number }>> {
    if (!this.backend) return fail('unconfigured', '引き継ぎは、現在利用できません');
    const auth = (await this.identity?.exportIdentity()) ?? null;
    const parts = await packPayload({ v: 1, save: saveJson, auth });
    if (!parts) return fail('rejected', 'セーブデータが大きすぎて、預けられません');
    const expiresAt = this.now() + TRANSFER_TTL_MS;
    // コードがたまたま重なった時 (ほぼ起きない) は、作り直して 1 回だけやり直す
    for (let attempt = 0; attempt < 2; attempt++) {
      const code = generateCode();
      const res = await this.backend.put(code, parts, expiresAt);
      if (res.ok) return ok({ code, expiresAt });
      if (res.reason !== 'rejected' || attempt === 1) return res;
    }
    return fail('server', '預けられませんでした');
  }

  /** 新しい端末: コードから、中身を受け取る (まだ何も書きかえない・預けた物も消さない)。 */
  async receive(rawCode: string): Promise<RankingResult<Received>> {
    if (!this.backend) return fail('unconfigured', '引き継ぎは、現在利用できません');
    const code = normalizeCode(rawCode);
    if (!code) return fail('rejected', `コードは ${CODE_LENGTH} 文字です。もう一度確かめてください`);
    const res = await this.backend.get(code);
    if (!res.ok) return res.reason === 'rejected' ? fail('rejected', 'コードが違うか、期限が切れています') : res;
    const payload = await unpackPayload(res.value);
    if (!payload) return fail('rejected', '預けられたデータを読めませんでした');
    return ok({ code, parts: res.value.length, payload });
  }

  /** 受け取りの仕上げ (セーブを書いたあとに呼ぶ): 匿名 ID を引き継ぎ、預けた物を消す。 */
  async finish(r: Received): Promise<void> {
    if (r.payload.auth) this.identity?.adoptIdentity(r.payload.auth.uid, r.payload.auth.refresh);
    await this.backend?.remove(r.code, r.parts);
  }
}

/** テスト・開発用の預け先 (メモリ)。Firestore のルールと同じ検査をする。 */
export class MemoryTransferBackend implements TransferBackend {
  readonly docs = new Map<string, { data: string; expiresAt: number; part: number; parts: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async put(id: string, parts: readonly string[], expiresAt: number): Promise<RankingResult<true>> {
    const ids = parts.map((_, i) => (i === 0 ? id : `${id}-${i}`));
    if (!normalizeCode(id) || parts.length < 1 || parts.length > MAX_PARTS || parts.some((p) => p.length > 950_000)) return fail('rejected', '形が不正です');
    if (expiresAt <= this.now() || expiresAt > this.now() + 25 * 60 * 60 * 1000) return fail('rejected', '期限が不正です');
    if (ids.some((x) => this.docs.has(x))) return fail('rejected', 'すでにあります');
    parts.forEach((data, part) => this.docs.set(ids[part], { data, expiresAt, part, parts: parts.length }));
    return ok(true);
  }

  async get(id: string): Promise<RankingResult<string[]>> {
    const head = this.docs.get(id);
    if (!head || head.expiresAt <= this.now()) return fail('rejected', 'ありません');
    const out = [head.data];
    for (let i = 1; i < head.parts; i++) {
      const d = this.docs.get(`${id}-${i}`);
      if (!d) return fail('rejected', '欠けています');
      out.push(d.data);
    }
    return ok(out);
  }

  async remove(id: string, parts: number): Promise<void> {
    for (let i = 0; i < parts; i++) this.docs.delete(i === 0 ? id : `${id}-${i}`);
  }
}
