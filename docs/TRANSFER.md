# データの引き継ぎ (引き継ぎコード)

端末を変える時に、キャラクター・進み具合・設定・ランキングの記録の持ち主を、ほかの端末へ移す仕組み。

## 1. 決めたこと (ユーザーの決定, 2026-10-09)

| | |
|---|---|
| 方法 | 引き継ぎコードだけ (ファイルでの書き出しは作らない) |
| ランキング | **記録の持ち主 (匿名 ID) も引き継ぐ**。新しい端末でベストを出すと、同じ記録が更新される |
| 元の端末 | データは残る (コピー)。同じ匿名 ID を、2 台で使う形になる |
| 受け取る側 | 今のデータは消える (上書き)。その前に、確認を出す |

## 2. 使い方

1. 元の端末: 設定 → データの引き継ぎ → **コードを作る** → 12 文字のコード (例 `K7M2-9QXA-4TPW`) が出る
2. 新しい端末: 設定 → データの引き継ぎ → **コードを入力** → 受け取るデータの内容と「今のデータは消えます」を確かめて、受け取る
3. 新しい端末が読み込み直されて、引き継いだデータで始まる

コードは **24 時間以内・1 回だけ**使える。オンラインが必要。

## 3. しくみ

* 預ける中身 (`src/transfer/transfer.ts`): `{ v: 1, save: セーブデータの JSON, auth: { uid, refresh } }` を gzip → base64 → 90 万文字ずつに分ける (Firestore の 1 件は 1MiB まで。最大 8 件)。
* 預け先 (`src/transfer/firestoreTransfer.ts`): Firestore のコレクション `transfers`。1 件目の id がコード、2 件目からは `コード-番号`。
* 受け取ったデータは、端末のセーブと同じ検査 (`parseSave`) を通す (壊れた所は直し、読めなければ受け取らない)。
* 順番: 受け取る → 確認 → セーブを書く → 匿名 ID を引き継ぐ → 預けた物を消す → 読み込み直す。**セーブを書けなかった時は、預けた物を消さない** (同じコードで、もう一度試せる)。
* コード: 12 文字、まぎらわしい文字 (0 O 1 I L) を除いた 31 種類 → 約 8×10^17 通り。

## 4. 安全について

* **コードを知っている人は、そのデータを受け取れて、ランキングの記録の持ち主にもなれる** (引き継ぐ以上、避けられない)。画面に「人に見せないでください」と出す。
* 守り: コードが長い・24 時間で読めなくなる・受け取ったら消える・一覧は誰も読めない (ルール)・書き換えはできない。
* 預けるのはゲームのデータ (キャラクターの絵と名前・進み具合・設定) と、匿名 ID の鍵だけ。メールアドレスなどの個人情報は、もともと持っていない。
* 匿名 ID の鍵 (refresh token) は、**預けている間 (最長 24 時間) だけ、サーバーにある**。受け取りが済めば消える。受け取られなかった物は、読めなくなったまま残る (下の「あとしまつ」)。

## 5. Firebase の準備 (管理者がやること)

`firebase/firestore.rules` を、Firebase コンソール → Firestore Database → ルール に**全部貼り直して**「公開」する (前のルールに、`transfers` のかたまりを足した物)。

足した部分:

```
match /transfers/{id} {
  function validTransfer() {
    let d = request.resource.data;
    return d.keys().hasOnly(['v', 'owner', 'expiresAt', 'part', 'parts', 'data'])
      && d.keys().hasAll(['v', 'owner', 'expiresAt', 'part', 'parts', 'data'])
      && d.v == 1
      && d.owner == request.auth.uid
      && d.expiresAt is timestamp
      && d.expiresAt > request.time
      && d.expiresAt < request.time + duration.value(25, 'h')
      && d.parts is int && d.parts >= 1 && d.parts <= 8
      && d.part is int && d.part >= 0 && d.part < d.parts
      && d.data is string && d.data.size() <= 950000
      && id.matches('^[2-9A-HJKMNP-Z]{12}(-[1-7])?$');
  }
  allow get: if request.auth != null && resource.data.expiresAt > request.time;
  allow list: if false;
  allow create: if request.auth != null && validTransfer();
  allow update: if false;
  allow delete: if request.auth != null;
}
```

### あとしまつ (おすすめ。しなくても動く)

受け取られなかったコードの中身は、読めなくなるだけで、Firestore には残る。自動で消すには、コンソール → Firestore Database → **TTL** (有効期間) で、コレクション グループ `transfers`・タイムスタンプのフィールド `expiresAt` のポリシーを作る (期限を過ぎた物が、1 日ほどで自動的に消える)。

## 6. 確かめたこと・まだのこと

* テスト (`tests/transfer/transfer.test.ts` 11 件): コードの形と入力の読み方・圧縮して分けて戻る・壊れた物は読まない・預ける → 受け取る → 仕上げ (ID の引き継ぎと、1 回きり)・期限切れ・未設定・ルールの文字の検査。
* ブラウザ (見本の預け先 = メモリ): 設定の行・コードの表示・入力 → 「受け取りますか？」の確認まで。
* **本物の Firebase では、まだ動かしていない** (ルールを公開してから確かめる): 預ける・受け取る・期限・匿名 ID を引き継いだあと、新しい端末のランキングの記録が同じ物になるか。
* 分かっている制限: 引き継いだあとは 2 台が同じ匿名 ID を使う (どちらの端末のベストでも、同じ記録が更新される)。受け取る側が前に使っていた匿名 ID の記録は、持ち主がいなくなる (ランキングに残る。管理者アプリで消せる)。古いブラウザ (gzip の機能が無い) では、大きなデータを預けられないことがある。
