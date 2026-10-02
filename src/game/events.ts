/** シミュレーションが発行するイベント。描画/SE/UI/ロジックが購読する。 */
export type SimEvent =
  | { type: 'jump' }
  | { type: 'land'; impact: number }
  | { type: 'attack' }
  | { type: 'hurt'; hp: number; maxHp: number }
  | { type: 'break'; id: string }
  /** 敵に ACTION / ふんづけが当たった。stomp / dash = 倒した、guard = 攻撃力が足りずはね返された */
  | { type: 'enemy'; id: string; how: 'stomp' | 'dash' | 'guard' }
  | { type: 'crumble'; id: string; state: 'shake' | 'fall' | 'restore' }
  | { type: 'respawn'; reason: 'fall' | 'hazard' | 'manual' }
  | { type: 'checkpoint'; id: string }
  | { type: 'goal' };
