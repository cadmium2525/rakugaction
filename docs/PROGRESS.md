# 開発進捗 / QA 記録

コンテキスト圧縮後もこのファイルから状態を復元する。各フェーズ完了時に追記する。

## 状態サマリ

| PHASE | 内容 | 状態 |
|---|---|---|
| 0 | リポジトリ調査・設計 | ✅ 完了 (docs/DESIGN.md) |
| 1 | 3D アクション最小プロトタイプ | ✅ 完了 |
| 2 | ラクガキエディタ | ✅ 完了 |
| 3 | 2D→3D 生成 + 誕生演出 | ✅ 完了 |

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

## PHASE 2: ラクガキエディタ

### 実装
* `src/drawing/model.ts` — ストローク列 (pen/erase/fill) のデータモデル、上限 (op 400/パーツ, 点 3000/ストローク)、座標は 1/4096 に量子化。パーツ = body/head/armLeft/armRight/legLeft/legRight。左 = 画像の右 (+x)。
* `src/drawing/raster.ts` — **Canvas 非依存**のソフトウェアラスタライザ (384²)。距離ベース AA、消しゴム、閉領域の塗りつぶし (外周に触れる領域は塗らない/線のにじみは塗りの上に重ねる)、ライブ描画と一括再生が一致。エディタ表示と 3D 化の元データが同一。
* `src/drawing/sanitize.ts` — 壊れた/悪意あるデータ (NaN/Infinity/範囲外/不正色/巨大) を安全な形へ。例外を投げない。
* `src/drawing/editorState.ts` — パーツ別 Undo/Redo、全消去 (Undo 可)、全リセット、左右コピー (OFF にすると反転コピーが出発点)。
* `src/drawing/defaults.ts` — 空のパーツは既定形状 (カプセル) で補う → 「何も描かなくても成立」。
* `src/character/layout.ts` — 6 パーツのマスクから頭/胴/腕/脚の配置を決定 (重ねて接続する方針)。PHASE 3 の 3D 化も同じ結果を使う。
* `src/ui/editor/*` — 4 ステップ (からだ→あたま→うで→あし)、ガイド、ペン/けす/ぬる/もどす/すすむ/ぜんぶ、12 色、4 太さ、ライブ合成ミニプレビュー、プレビューモーダル。
* `src/ui/titleScreen.ts`, `src/app/app.ts` — タイトル → エディタの画面遷移。ゲームシーンは離れる時に WebGL ごと破棄。

### 自動テスト (tests/drawing/core.test.ts, 38 件 / 累計 61 件)
sanitize (NaN/範囲外/不正色/壊れた JSON/巨大データ)、raster (点/最小幅の線/塗りつぶし/外周リーク無し/再塗り/消しゴム/8 の字/端/巨大ジャンプ/ライブ=一括/400op 再生 3 秒以内)、EditorState (Undo/Redo/履歴独立/全消去/上限/左右コピー)、**極端ラクガキ 16 種のレイアウトが全て有限値** (`tests/helpers/doodles.ts`: normal/giant/tiny/longLegs/shortLegs/longArms/fat/thin/asymmetric/weird/edgeHugging/scatteredDots/empty/bodyOnly/chaos…)。

### ブラウザでの確認
* 844×390 / 667×375 で全要素が収まる (右サイドのオーバーフロー 0)。縦画面は回転案内。
* 実マウスドラッグで描画。合成 PointerEvent で: 点だけ/巨大円+塗り/細長線/画面端/自己交差/高速ジャンプ/**指が紙の外へ出たらそこで線を終える**/**2 本目の指は無視**/Undo-Redo-全消去/左右コピー切替/左→右コピー。
* 600 点ストロークで 1 イベント 0.17ms (デスクトップ)、Undo 6ms、Redo 58ms (最重ブラシ)。
* Console error/warn なし。PHASE 1 (アリーナ) の回帰 OK。

### 既知の課題
* 描画キャンバスは 384px を CSS 拡大表示 (高 dpi でやや柔らかい)。必要なら RASTER_RES を上げる。
* アプリ内ブラウザの screenshot はペイン非表示時にタイムアウトしやすい (再試行で取得可)。

## PHASE 3: 2D→3D 生成 + 誕生演出

### 実装
* `src/character/maskOps.ts` — 距離変換 (Felzenszwalb 厳密 EDT)、穴埋め (外周 8 近傍連結を外とみなす)、4 近傍ラベリング、小片除去 (最大成分は必ず残す)、膨張、内接円半径。
* `src/character/contour.ts` — ピクセル境界追跡 (ピンチ点は右折して成分を分離 = 常に単純な輪郭)、[1 2 1] 平滑化、Douglas-Peucker、自己交差検査。**平滑化/許容誤差を段階的に弱めて再試行 → 最後は凸包**で、どんな絵でも単純多角形を得る。
* `src/character/cleanPart.ts` — シルエット整形 (穴埋め → ゴミ除去 → 最小の太さ補正 + 常時 2px 膨張) とテクスチャ生成 (192²、囲まれた未塗りは紙色、膨らませた縁は近傍色でにじませ)。
* `src/character/partGeometry.ts` — ExtrudeGeometry + ベベル (bevelOffset 負 = シルエットは描いた形のまま) + creased normals + 平面投影 UV。**側面/ベベルは輪郭線の内側の色をサンプル**して、黒い縁取りが側面全体に回らないように。裏面は暗く。三角形予算 3200/パーツ (超えたら輪郭を粗くして作り直し)。
* `src/character/builder.ts` — `buildCharacter(drawing)`: 6 パーツ → 整形 → レイアウト → rig 組み立て (root→body→head/armL/armR/legL/legR、関節がピボット)。前面をそろえた Z 配置 (2D プレビューと同じ重なり)。例外を投げない。
* `src/render/renderHost.ts` — WebGL (canvas) をアプリ全体で 1 つに共有 (ゲーム/誕生など複数ビューが借りる)。GameView は借りる側へ。
* `src/render/showcaseView.ts`, `src/ui/birthScreen.ts` — 誕生演出: 平らなラクガキが浮かぶ → ポンッと立体化 (z スケールがエラスティックに膨らみ回転) + キラキラ → 着地スカッシュ + 砂ぼこり → 「たんじょう！」→ ボタン。タップでスキップ。ターンテーブル待機。
* `src/dev/doodles.ts` — 極端ラクガキ 15 種のフィクスチャ (テストと `?birth=<name>` で共有)。

### 自動テスト (tests/character/geometry.test.ts 29 件 / 累計 90 件)
EDT/穴埋め (8 近傍の隙間)/小片除去/膨張、輪郭 (正方形=20 点, ピンチ=2 ループ, 円: 点数<=96・単純・面積誤差 +-7%, 星/渦, 蝶ネクタイ非単純, 凸包)、
**極端ラクガキ 15 種を buildCharacter**: 全アトリビュート有限 (NaN/Infinity なし)、パーツ三角形 30〜6000、合計 <20000、draw call 6、リグ階層、全高が目標の 85〜120%、足が地面に埋まらない/浮かない、幅/奥行きの妥当範囲、テクスチャ 192² RGBA、生成 <3 秒 (Node)、dispose。
標準ラクガキ: 頭が胴の上/左腕 +x/右腕 -x/左右コピー時の寸法一致/dispose でジオメトリ破棄。
計測: 標準 1,654 tris・約 130-280ms (Node)、最悪 'weird' 4,750 tris。

### ブラウザでの確認
* エディタ (実 UI 操作) → 「できあがり」→「誕生させる」→ 誕生演出 → 「あそぶ」でアリーナへ、ラクガキキャラで走る/ジャンプ (draw calls 14, 約 2,750 tris, Console error なし)。
* `?birth=normal|weird|…` で平らな状態/ポップ途中/着地後/横から見た 3D を確認。厚み・ベベル・側面の塗り色を目視確認。

### 発見して修正した主要問題
* 渦巻きの輪郭が凸包にフォールバックして形を失う → 平滑化を段階的に弱める再試行を追加 (fallback 0 に)。
* 側面が黒い縁取り色で塗られる → UV を輪郭の内側へずらして塗り色をサンプル (厚み 3 乗の重み)。内接円半径ベースの距離を採用 (中央値半幅は円で過小評価)。
* 誕生ホップが画面外へ出る → 高さ縮小。

### 注意 / 次フェーズ以降
* 物理暴走テスト (ラクガキ → 能力 → 実際の移動) は PHASE 5 (能力生成) で全ドゥードルに対して実施。現状コライダーはラクガキの寸法に依存しない (stats/traits のみ)。
* アプリ内ブラウザはペイン非表示だと rAF が止まる (誕生の生成は 2rAF 待ちなので表示されるまで進まない)。実機では問題なし。
