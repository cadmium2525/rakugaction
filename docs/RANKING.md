# オンラインランキング (ALL STAGES TIME ATTACK)

このゲームは GitHub Pages だけで動きます。ランキングを使いたい時だけ、無料の Firebase (Spark プラン) を用意して設定を 1 つ置きます。
**設定しなくてもゲームは完全に遊べます** (ランキング画面が「準備中」になるだけ)。

## 仕組み

| 項目 | 内容 |
|---|---|
| バックエンド | Firebase Firestore (REST 直叩き。SDK は同梱しない) + 匿名認証 (Identity Toolkit REST) |
| 1 ユーザー | 1 ドキュメント `ranking/{uid}` = そのユーザーのベストだけ |
| 閲覧 | ログイン不要。TOP100 (総タイム昇順) / 自分の記録 / 自分の順位 (= 自分より速い記録の数 + 1) |
| 送信 | ALL STAGES を完走した結果画面の「🏆 ランキングに登録」。送信時だけ匿名ユーザーを作る (初回のみ。refreshToken を端末の localStorage に保存) |
| 記録される値 | 表示名・ビルドのラベル・総タイム・各ステージのタイム ×5・シム上の総経過・死亡回数・プレイヤーレベル・能力値 ×6 (レベル補正後)・ゲームバージョン・paramsHash・送信時刻 |
| 失敗時 | 全ての操作は例外を投げず結果で返す。オフライン/タイムアウト (8 秒)/サーバーエラー/拒否/未設定を区別してメッセージを出す。ゲームの進行・保存には影響しない |

### 秘密情報について
* クライアントに置くのは **Web API キーと projectId だけ**。API キーは Firebase では「公開前提の識別子」で秘密ではありません (保護は Firestore のセキュリティルールが担います)。
* **管理者権限・サービスアカウントの鍵・秘密のトークンは絶対にクライアント/リポジトリに置かないでください。** このゲームはそれらを必要としません。
* 念のため Google Cloud コンソールで API キーに「HTTP リファラー制限」(公開 URL のみ許可) と「API 制限」(Identity Toolkit API / Cloud Firestore API のみ) をかけることを推奨します。

## セットアップ手順

1. [Firebase コンソール](https://console.firebase.google.com/) で新しいプロジェクトを作る (Spark = 無料)。
2. **Authentication → Sign-in method → 匿名 (Anonymous)** を有効にする。
3. **Firestore Database** を作成する (本番モード、ロケーションは任意)。
4. **ルールを公開**: `firebase/firestore.rules` の内容を Firestore の「ルール」タブに貼って公開する (または `firebase deploy --only firestore:rules`)。
5. プロジェクトの設定 → 「全般」で **ウェブ API キー** と **プロジェクト ID** を控える。
6. `public/ranking-config.json` を次のように書き換える (`public/ranking-config.example.json` を参考に):
   ```json
   { "enabled": true, "apiKey": "AIza…", "projectId": "your-project-id", "collection": "ranking" }
   ```
7. ビルド/デプロイ (`npm run build` → GitHub Pages)。ランキング画面と結果画面のボタンが有効になる。

`enabled` が `true` でない / キーの形式が不正な場合は「未設定」として扱われ、ランキング機能だけが無効になります。

## 不正対策 (最善努力。完全な防止は目標外)

クライアントだけで動くゲームでは、記録の改ざんを完全には防げません。ここでは「明らかな異常値の排除」「後から調べられる情報の記録」までを行います。

### クライアント側
* ステージのタイマーは `performance.now()` (単調増加時計)。端末の時刻を変えても影響されない。ポーズ・ロード・演出中は止まる。
* シミュレーション上の経過 (`simMs`) と実時間 (`timeMs`) を比べ、シムが実時間より速く進んでいたら `clock-mismatch`、par の 30% 未満なら `implausible-time`、ステージ順がおかしければ `bad-order` のフラグを付ける。**フラグ付きの走りは参考記録 (ベスト/EXP/ランキング送信の対象外)**。
* 送信前に `validateSubmission` で値域を検査 (サーバーの rules と同じ条件)。

### サーバー側 (`firebase/firestore.rules`)
* 書き込みは本人 (`request.auth.uid == uid`) のドキュメントだけ。更新は **今のベストより速い時だけ**。削除は不可。許可フィールドは固定 (`hasOnly` + `hasAll`)。
* 各値の値域: 各ステージのタイムは 最短 (S1 20 秒 / S2 18 秒 / S3 16 秒 / S4 17 秒 / S5 20 秒。ボットの最速ルートの約 55%) 〜 20 分、`timeMs` は **splits の合計と一致**、レベル 1〜20、能力値 20〜300 の整数、名前 16 文字以内、`flags` は空、送信時刻とサーバー時刻のずれ ±10 分以内。
* 値は `src/ranking/validate.ts` の `RANK_LIMITS` と同じ。**変更する時は両方を揃える** (`tests/ranking/rules.test.ts` が一致を検査します)。

### 記録されるが、まだ使っていない情報
`gameVersion` (仕様/バランスを変えたら `src/core/version.ts` を上げる → 古い記録を別集計にできる)、`paramsHash` (同じビルド/レベルの記録をまとめる目印)、`simMs`、`deaths`。異常な記録を見つけた時にコンソールから調べて削除できます (rules 上、クライアントからは削除不可)。

## 無料枠の目安と対策
Spark プランは 1 日あたり 読み取り 50,000 回 / 書き込み 20,000 回。TOP100 の表示は 100 回の読み取りになるため、**ランキング画面は 60 秒キャッシュ** (`BOARD_CACHE_MS`) し、↻ ボタンで強制再読み込みします。順位の取得は集計クエリ (count) で、読み取り 1 回分未満の課金です。

## 個人情報
名前 (キャラクター名)・能力値・タイムだけを保存します。メールアドレス等は取りません (匿名認証)。名前は画面に表示する前に整形し (制御文字/双方向制御文字の除去・16 文字まで)、HTML としては解釈しません (`textContent` のみ)。不適切な名前の自動判定はしていません。削除の依頼は Firebase コンソールから該当ドキュメントを削除してください。

## 開発・テスト
* `?ranking=mock` (開発サーバー/`?debug=1` のみ): メモリ上のモックバックエンド。rules と同じ検査 (値域・合計・時刻のずれ・「速い時だけ更新」) をする。
* 自動テスト (`tests/ranking/`): 検査・コーデック・Firestore REST クライアント (偽サーバー `fakeFirestore.ts` に対して、匿名ログイン/トークン更新/送信/順位/タイムアウト/拒否/オフライン)・モック・サービス (キャッシュ/例外)・設定・rules と `RANK_LIMITS` の一致。
* **本物の Firebase への書き込み・rules の動作は未検証** (このリポジトリには Firebase プロジェクトの設定がないため)。公開前に上のセットアップ手順で実際に 1 件送信して確認してください。rules は [Rules Playground](https://firebase.google.com/docs/firestore/security/test-rules-emulator) または Emulator Suite で試せます。
