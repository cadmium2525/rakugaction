/** シミュレーションが発行するイベント。描画/SE/UI/ロジックが購読する。 */
export type SimEvent =
  | { type: 'jump' }
  | { type: 'land'; impact: number }
  | { type: 'attack' }
  | { type: 'hurt'; hp: number; maxHp: number }
  | { type: 'break'; id: string }
  | { type: 'crumble'; id: string; state: 'shake' | 'fall' | 'restore' }
  | { type: 'respawn'; reason: 'fall' | 'hazard' | 'manual' }
  | { type: 'checkpoint'; id: string }
  | { type: 'goal' };
