# 開発進捗 / QA 記録

コンテキスト圧縮後もこのファイルから状態を復元する。各フェーズ完了時に追記する。

## 状態サマリ

| PHASE | 内容 | 状態 |
|---|---|---|
| 0 | リポジトリ調査・設計 | ✅ 完了 (docs/DESIGN.md) |
| 1 | 3D アクション最小プロトタイプ | ✅ 完了 |

## 検証できない項目 (実機固有・未検証)

* iPhone Safari / 実 Android Chrome での実際の指操作・fps・発熱 (アプリ内ブラウザ + PointerEvent 合成で代替検証)
* 実機の safe-area-inset (ノッチ/Dynamic Island/ホームインジケータ) — CSS で `env()` を使用しているが実機未確認
* Firestore 実環境でのランキング書き込み (Firebase プロジェクト未作成のため)

## PHASE 1: 3D アクション最小プロトタイプ

### 実装
* `src/game/player.ts` — Rapier KinematicCharacterController ベースの操作。コヨーテタイム/ジャンプバッファ/可変ジャンプ/下降時重力増/慣性(WEIGHT)/風への耐性フック。
* `src/game/sim.ts` — DOM/WebGL 非依存のシミュレーション。移動床(経過時間から決定的)・チェックポイント・ゴール・奈落復活。
* `src/game/params.ts` — 能力値 → 挙動パラメータ。
* `src/game/camera.ts` — 追従カメラ(弱い自動回り込み + 右スワイプ + レイキャストでめり込み防止)。
* `src/input/*` — キーボード、タッチ(フローティングスティック/JUMP/ACTION/カメラスワイプ。pointerId 単位のマルチタッチ)。
* `src/render/*` — GameView(動的解像度・品質設定・コンテキストロスト通知)、ステージ静的メッシュを頂点カラー 1 draw call に統合、丸影。
* `src/stages/testArena.ts` — 壁/坂/段差/空中ギャップ/移動床/天井のテスト場。`?debug=1` でデバッグパネル + ビルド切替。

### 自動テスト (tests/physics/player.test.ts, 23 件)
床接地/高速落下で薄い床を貫通しない/静置で沈まない・浮かない、薄い壁を全ビルドで抜けない、壁ジャンプ連打で登れない/抜けない、壁沿い滑り、ジャンプ高さ=v²/2g、可変ジャンプ、空中ジャンプ不可、ジャンプ連打で jump=land、コヨーテタイム、30°坂登坂/60°急斜面不可/下り坂接地/段差、天井、移動床搬送、NaN/Infinity 入力耐性、決定性、奈落復活、SPEED/JUMP/WEIGHT が挙動に反映。

### ブラウザでの確認 (アプリ内ブラウザ)
* 起動・描画 OK。Console error/warn なし。16 draw calls / 約 2,140 tris (テストアリーナ)。
* キー入力 (W+Space) で前進・ジャンプ・停止。
* 合成 PointerEvent でマルチタッチ: スティック + JUMP 同時、ACTION、カメラスワイプ中もスティック維持、pointercancel でスティック解除、blur で全ボタン解除。
* 375/390 縦画面で「横向きにしてください」表示、横 667×375 / 844×390 でリサイズ追従 (canvas バッファ/カメラアスペクト)。

### 発見して修正した問題
* 天球が far plane でクリップされ黒く表示 → 半径 100 + depthTest 無効に。
* `setPointerCapture` が存在しないポインターで例外 → 失敗しても操作は継続できるので `capturePointer()` ヘルパで捕捉 (理由コメント付き)。
* スティック離した後に定位置へ戻らない → 離した時に inline style を解除。
* ヘッドレス/非表示タブでは rAF が止まる → `PlayScene.tick(dt)` を公開して自動テストから駆動できるように。

### 既知の課題 / 次フェーズ以降
* 縦画面時の自動ポーズは PHASE 15 で実装。
* Rapier チャンクは 4.3MB (gzip 1.67MB)。動的 import 済み。初回はタイトル表示中にプリロードする予定。
