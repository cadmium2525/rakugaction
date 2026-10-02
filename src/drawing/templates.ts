import { newSlot } from './model';
import type { PartSlot } from './model';

/** 描き始めの「ひな形」。パーツの組み合わせ (向き・ペア) だけを決める。絵は空で、取り付け位置は自動。 */
export interface Template {
  id: string;
  label: string;
  icon: string;
  description: string;
  /** 先頭は必ず胴体 */
  make(): PartSlot[];
}

const body = (view: 'front' | 'side'): PartSlot => newSlot('body', 'body', { view });

export const TEMPLATES: readonly Template[] = [
  {
    id: 'human',
    label: '人型',
    icon: '🧍',
    description: '胴体・頭・腕・脚。正面から見た絵で描く',
    make: () => [body('front'), newSlot('head', 'head'), newSlot('arms', 'arm', { pair: true }), newSlot('legs', 'leg', { pair: true })],
  },
  {
    id: 'quadruped',
    label: '四足の動物',
    icon: '🐕',
    description: '横から見た絵 (右向き)。前脚と後ろ脚、しっぽ',
    make: () => [
      body('side'),
      newSlot('head', 'head', { view: 'side' }),
      newSlot('legsF', 'leg', { view: 'side', pair: true }),
      newSlot('legsB', 'leg', { view: 'side', pair: true }),
      newSlot('tail', 'tail', { view: 'side' }),
    ],
  },
  {
    id: 'asura',
    label: '多腕 (阿修羅)',
    icon: '🧘',
    description: '腕が 6 本。胴体・頭・腕 3 組・脚',
    make: () => [
      body('front'),
      newSlot('head', 'head'),
      newSlot('arms1', 'arm', { pair: true }),
      newSlot('arms2', 'arm', { pair: true }),
      newSlot('arms3', 'arm', { pair: true }),
      newSlot('legs', 'leg', { pair: true }),
    ],
  },
  {
    id: 'bird',
    label: '鳥・翼のある生きもの',
    icon: '🐦',
    description: '正面の絵。翼・脚・しっぽ',
    make: () => [body('front'), newSlot('head', 'head'), newSlot('wings', 'wing', { pair: true }), newSlot('legs', 'leg', { pair: true }), newSlot('tail', 'tail')],
  },
  {
    id: 'insect',
    label: '虫・多足',
    icon: '🐛',
    description: '横から見た絵。脚が 6 本、頭としっぽ',
    make: () => [
      body('side'),
      newSlot('head', 'head', { view: 'side' }),
      newSlot('legs1', 'leg', { view: 'side', pair: true }),
      newSlot('legs2', 'leg', { view: 'side', pair: true }),
      newSlot('legs3', 'leg', { view: 'side', pair: true }),
      newSlot('tail', 'tail', { view: 'side' }),
    ],
  },
  {
    id: 'blob',
    label: 'ゆるキャラ',
    icon: '🫧',
    description: '胴体が主役。頭と脚だけのシンプルな形',
    make: () => [body('front'), newSlot('head', 'head'), newSlot('legs', 'leg', { pair: true })],
  },
  {
    id: 'free',
    label: '胴体だけ',
    icon: '✏️',
    description: '胴体だけで始めて、必要なパーツを自分で足す',
    make: () => [body('front')],
  },
];

export function templateOf(id: string): Template | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
