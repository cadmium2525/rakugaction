# RAKUGACTION 設計書 (PHASE 0)

ラクガキから生まれた自分だけのキャラクターで遊ぶ 3D アクションゲーム。
静的ホスティング(GitHub Pages)のみで動き、描画 → 3D 化 → 物理 → 保存まで全てブラウザ内で完結する。

## 1. 現状分析

| 項目 | 結果 |
|---|---|
| ディレクトリ | 完全に空 (グリーンフィールド) |
| package.json / 既存ライブラリ | なし |
| GitHub Pages 設定 | なし (→ `.github/workflows/deploy.yml` を新規作成) |
| Firebase 等 | 設定なし → ランキングは「バックエンド差し替え可能な抽象 + Firestore REST 実装 + セキュリティルール」を用意 |
| git | 未初期化 → `git init` 済み、フェーズ単位でコミット |
| 実行環境 | Node 24 / npm 11 / Windows 11。ブラウザ操作はアプリ内ブラウザを使用 |

既存コードがないため「既存技術との整合性」の制約はない。

## 2. 採用アーキテクチャ

### 技術スタック
| 技術 | 採用理由 | モバイル影響 / Pages 適合 |
|---|---|---|
| Vite 8 + TypeScript 6 | ビルド/HMR/型安全。フレームワークではなくビルドツール | 出力は静的ファイルのみ。`base: './'` でサブパス配信 OK |
| Three.js | 3D 描画 (必須) | tree-shaking 済み ~ 600KB (gzip 150KB 程度) |
| Rapier (`@dimforge/rapier3d-compat`) | 物理 (必須)。WASM を base64 内蔵するので追加ファイル不要・CORS 不要 | ~ 2MB (gzip 600KB)。動的 import で初回描画を邪魔しない。Kinematic Character Controller が壁/坂/段差に強い |
| Vitest | ロジック/物理ヘッドレステスト | 開発時のみ |
| ESLint (typescript-eslint) | lint | 開発時のみ |
| fake-indexeddb | IndexedDB のテスト | 開発時のみ |

UI フレームワーク (React 等) は使わない。DOM + CSS + Canvas 2D の素朴な構成。

### 設計原則
1. **シミュレーションと描画の分離** — `GameSim` (Rapier + プレイヤー制御 + ギミック) は DOM/WebGL に非依存。Node 上でヘッドレス実行でき、ボット攻略/バランス計測/回帰テストに使う。
2. **ラクガキは「ベクターのストローク列」で保持** — Undo/Redo・保存・左右反転・再生成が容易。ラスタライズは自前ソフトウェア実装 (Canvas 非依存) なので Node でテスト可能。
3. **ステージは宣言的データ (StageDef)** — 衝突ジオメトリと見た目を同じ定義から生成。ボット用ルートヒントも同梱。
4. **能力 → 挙動の写像は純関数** — `computeStats()` / `statsToParams()` / `applyLevel()` をユニットテスト。
5. **保存・ランキングは抽象化** — IndexedDB → localStorage → メモリの順にフォールバック。ランキングは `RankingBackend` インターフェース。
6. **ゲーム時間は単調増加時計** — `performance.now()`。操作不能時間 (ロード/演出/ポーズ/バックグラウンド) は除外。

### 座標・単位
メートル、Y-up、固定 60Hz 物理 (1/60 s)、描画は補間。標準キャラの高さ ≒ 1.6m、重力 -24 m/s²。

## 3. ディレクトリ構成

```
index.html
package.json / tsconfig.json / vite.config.ts / eslint.config.js
public/                     静的ファイル (manifest, アイコン, ranking-config.json)
src/
  main.ts                   起動
  core/                     math, rng, version, fixed-step loop, clock(テスト可能)
  input/                    InputState, keyboard, タッチ UI(仮想スティック/ボタン/カメラスワイプ)
  physics/                  Rapier ラッパ (遅延ロード)
  game/                     GameSim, PlayerController, ギミック, カメラ, ステージランタイム
  stages/                   StageDef 型・ヘルパ・STAGE1..5
  render/                   renderer, 品質設定, ステージ/キャラメッシュ, 空, 影, 演出
  drawing/                  ストロークモデル, ラスタライズ, サニタイズ, エディタ状態, エディタ UI
  character/                輪郭抽出, 3D 化, リグ, 手続きアニメ, 解析, 能力, プリセット
  progression/              EXP / レベル / 解放
  timeattack/               タイマー, セッション (5 ステージ連続)
  save/                     スキーマ, マイグレーション, IndexedDB ストア
  ranking/                  型, 検証, Backend IF, Firestore REST, モック
  ui/                       画面 (title/editor/birth/hub/result/ranking/settings), HUD, CSS
  app/                      App, 画面遷移
tests/                      Vitest (ロジック + ヘッドレス物理 + ボット攻略)
scripts/                    確認用スクリプト (GitHub Pages 風のサブパス配信 `npm run preview:pages`)
docs/                       DESIGN / PROGRESS / RANKING (+ 最終整備の README.md はルート)
firebase/firestore.rules    ランキング用セキュリティルール
.github/workflows/deploy.yml
```

## 4. 開発フェーズ

PHASE 0 設計 → 1 3D アクション試作 → 2 ラクガキエディタ → 3 2D→3D → 4 アニメ → 5 能力生成 → 6-10 STAGE 1-5 → 11 ユーザーレベル → 12 タイムアタック → 13 ランキング → 14 セーブ/ロード → 15 スマホ最適化 → 16 総合 QA → 最終整備 (README)。
進捗・検証結果は `docs/PROGRESS.md` に毎フェーズ追記する (コンテキスト圧縮後もこれで状態を復元する)。

## 5. テスト戦略

| 層 | 手段 |
|---|---|
| 純ロジック (能力/EXP/レベル/タイマー/検証/マイグレーション/ストローク) | Vitest ユニットテスト |
| 3D 化 | 極端ラクガキ 10+ 種で NaN/Infinity/空ジオメトリ/ポリゴン数/境界を自動検査 |
| 物理・操作感 | Rapier をヘッドレス実行。壁抜け/床抜け/ジャンプ連打/空中ジャンプ/坂を再現テスト |
| ステージ攻略 | ボット (ウェイポイント追従 + 自動ジャンプ) が STANDARD/SPEED/JUMP/HEAVY/POWER/EXTREME で走破。タイム/死亡/落下を記録 |
| 能力分布 | ランダム 1000 形状で分布・トレードオフ・単一最適解の有無を検査 |
| ブラウザ実機相当 | アプリ内ブラウザで起動 → 描画 → 生成 → 操作 → クリア → 保存 → リロード。Console/Network 確認。マルチタッチは PointerEvent 合成で検証 |
| 実機固有 (iOS Safari の挙動, 本物のタッチ, 発熱/fps) | 検証不可 → `docs/PROGRESS.md` に「未検証」と明記 |

フェーズ終了時のゲート: lint → test → build → ブラウザ起動 → Console error 0 → テストプレイ → 修正/再テスト → 回帰。

## 5.5 敵と見た目の作り込み (PHASE 17: STAGE 1 で試作)

* **敵** (`src/game/enemies.ts` + `GameSim`): 4 種類 (blob / hopper / spiky / chaser)。巡回する敵は位置が経過時間の関数 (移動床と同じ = 決定的)、chaser だけプレイヤーの位置で動く。判定は円柱 × 円柱。優先順位は ACTION → ふんづけ → 接触ダメージ。ACTION は `attackPower >= toughness` で倒す (木箱と同じ仕組み)。ふんづけは落下中 (vy <= -1) に足が敵の上の方に来た時 (トゲの敵は不可)。復活 (`respawn`) で全員元に戻る。ボットは「前方で届く範囲の、倒せる敵に ACTION」で対応する。
* **見た目** (すべてコードだけ。Blender や外部素材は使わない): ① 表面の模様 (`surfaceMaterial.ts`: ワールド座標の手続き的な模様をトゥーン材質に注入。草・石・木・レンガなど。画質 LOW では無効) ② 小道具の道具箱 (`stages/decorKit.ts`) と、コースの形に合わせて置く `stages/meadow.ts` (縁の草・花・柵・浮島・雲海・丘) ③ 看板 (`signView.ts`) ④ 空気感 (`ambientView.ts`: 花粉・花びら・ちょうちょ) ⑤ 太陽。敵はパーツを 1 体ごとに結合して軽くしている。

## 6. ランキング方針 (PHASE 13 で詳細化)

* バックエンド: Firebase Firestore (Spark 無料枠) + 匿名認証。**REST 直叩き**で SDK を同梱しない。API キーは公開前提の識別子で秘密ではない。管理者権限/秘密鍵はクライアントに置かない。
* 1 ユーザー 1 ドキュメント (uid)。ルールで「ベストの更新のみ」「値域」「スプリット合計 = 総タイム」「最小可能タイム」を検証。
* 記録: timeMs / splits[5] / level / characterSummary / stats / paramsHash / gameVersion / flags / 実時間と シム時間の差。後から検証ロジックを追加できるよう `schemaVersion` を持つ。
* 完全な不正防止は目標外。異常値検出とフラグ化まで。
* 未設定/オフライン時はランキング機能のみ「利用不可」表示、ゲーム本体は影響を受けない。
