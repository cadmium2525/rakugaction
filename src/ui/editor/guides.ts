import type { PartKey } from '../../drawing/model';

/** お絵かきのガイド (下書き用の薄い目安)。データには含まれず、描画の邪魔にならない程度の濃さ。 */
export function drawGuides(canvas: HTMLCanvasElement, key: PartKey, mirrored: boolean): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  ctx.save();
  if (mirrored) {
    ctx.translate(S, 0);
    ctx.scale(-1, 1);
  }
  const u = (v: number): number => v * S;
  ctx.lineWidth = Math.max(2, S * 0.006);
  ctx.strokeStyle = 'rgba(120, 100, 70, 0.28)';
  ctx.fillStyle = 'rgba(120, 100, 70, 0.55)';
  ctx.setLineDash([S * 0.02, S * 0.02]);
  ctx.font = `700 ${Math.round(S * 0.04)}px sans-serif`;
  ctx.textAlign = 'center';

  // 中心線 (左右対称の目安)
  ctx.beginPath();
  ctx.moveTo(u(0.5), u(0.04));
  ctx.lineTo(u(0.5), u(0.96));
  ctx.stroke();

  const label = (text: string, x: number, y: number): void => {
    ctx.save();
    if (mirrored) {
      // 文字は反転させない
      ctx.translate(u(x), u(y));
      ctx.scale(-1, 1);
      ctx.setLineDash([]);
      ctx.fillText(text, 0, 0);
    } else {
      ctx.setLineDash([]);
      ctx.fillText(text, u(x), u(y));
    }
    ctx.restore();
  };
  const dot = (x: number, y: number): void => {
    ctx.save();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(u(x), u(y), S * 0.018, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  };

  ctx.beginPath();
  switch (key) {
    case 'head':
      ctx.arc(u(0.5), u(0.46), u(0.3), 0, Math.PI * 2);
      ctx.stroke();
      dot(0.5, 0.9);
      label('首', 0.5, 0.96);
      break;
    case 'body':
      ctx.roundRect(u(0.27), u(0.12), u(0.46), u(0.76), u(0.12));
      ctx.stroke();
      dot(0.27, 0.26);
      dot(0.73, 0.26);
      label('肩', 0.5, 0.2);
      dot(0.5, 0.92);
      label('腰', 0.5, 0.98);
      break;
    case 'armLeft':
    case 'armRight':
      ctx.roundRect(u(0.41), u(0.1), u(0.18), u(0.7), u(0.09));
      ctx.stroke();
      dot(0.5, 0.1);
      label('肩', 0.5, 0.07);
      break;
    case 'legLeft':
    case 'legRight':
      ctx.roundRect(u(0.39), u(0.1), u(0.22), u(0.76), u(0.09));
      ctx.stroke();
      dot(0.5, 0.1);
      label('腰', 0.5, 0.07);
      break;
  }
  ctx.restore();
}
