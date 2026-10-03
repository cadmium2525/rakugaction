/**
 * エディタの機能の入り切り (ビルド時の定数)。作り込んだが、今は出さない機能を、コードを消さずに止めておくための場所。
 * 戻す時は、該当の値を true にするだけ (README・docs/PROGRESS.md の PHASE 23b に、止めた理由と戻し方がある)。
 */
export const EDITOR_FEATURES = {
  /**
   * お手本を敷いてなぞる機能 (紙の左下の 🖼。`refImage.ts` と、editorScreen.ts の「お手本」の節)。
   * 止めている理由: 写真をなぞれると、「ラクガキ」から生まれるキャラクターというゲーム性を損ねるおそれがあるため。
   * true にすると、紙の左下に 🖼 が出る (画像は端末の中だけで使い、保存も送信もしない)。
   */
  referenceImage: false,
} as const;
