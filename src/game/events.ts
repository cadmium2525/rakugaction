/** シミュレーションが発行するイベント。描画/SE/UI/ロジックが購読する。 */
export type SimEvent =
  | { type: 'jump' }
  | { type: 'land'; impact: number }
  | { type: 'attack' }
  | { type: 'hurt'; hp: number; maxHp: number }
  /** チェックポイントで HP が全回復した */
  | { type: 'heal'; hp: number; maxHp: number }
  | { type: 'break'; id: string }
  /** ACTION が木箱に当たったが、攻撃力が足りず壊せなかった */
  | { type: 'breakGuard'; id: string }
  /** 敵に ACTION / ふんづけが当たった。stomp / dash = 倒した、guard = 攻撃力が足りずはね返された */
  | { type: 'enemy'; id: string; how: 'stomp' | 'dash' | 'guard' }
  | { type: 'crumble'; id: string; state: 'shake' | 'fall' | 'restore' }
  /** dist = ミスした場所からチェックポイントまでの水平の距離 (m) */
  | { type: 'respawn'; reason: 'fall' | 'hazard' | 'manual'; dist: number }
  | { type: 'checkpoint'; id: string }
  /** アイテムを取った。count = 取った数 (この 1 個を含む) */
  | { type: 'pickup'; id: string; count: number; required: number; total: number }
  /** 出現条件のある星が現れた (その範囲の敵を全員倒した) */
  | { type: 'pickupAppear'; id: string }
  /** アイテムが足りないのでゴールが開かない (ゴールに触れた時。一定間隔で出る) */
  | { type: 'goalLocked'; need: number }
  | { type: 'goal' };
