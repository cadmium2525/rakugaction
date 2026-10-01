# RAKUGACTION — 開発メモ

ラクガキ → 3D キャラ → 3D アクション (GitHub Pages で静的配信)。仕様は docs/DESIGN.md、進捗/QA は docs/PROGRESS.md。

## コマンド
* `npm run dev` — 開発サーバー (`PORT` 環境変数でポート指定可。`.claude/launch.json` の preview_start で起動)
* `npm run lint` / `npm run typecheck` / `npm test` / `npm run build` — フェーズ終了ゲート
* ブラウザでの自動操作: `?debug=1` (または dev サーバー) で `window.__rg` (App) が使える。**非表示タブでは rAF が止まる**ので
  `window.__rg.scene.tick(1/60)` を JS から回して駆動する。

## 規約
* シミュレーション (`src/game`, `src/stages`, `src/character` のロジック部) は DOM/WebGL に依存させない → Node で Vitest 実行可能。
* 単位は m / s、固定ステップ 60Hz (`FIXED_DT`)。Y-up。プレイヤー yaw 0 = +Z 向き。
* Bash ツールのヒアドキュメントはバッククォート/アポストロフィを含む長いコードで失敗しやすい → ファイル作成は Write ツールを使う。
* 例外を握りつぶさない。やむを得ず捕捉する場合は理由をコメントに書く。
* ランキング等の秘密情報/管理者鍵をコミットしない。
