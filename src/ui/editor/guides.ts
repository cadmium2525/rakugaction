import type { PartSlot } from '../../drawing/model';

/** お絵かきのガイド (下書き用の薄い目安)。データには含まれず、描画の邪魔にならない程度の濃さ。 */
export function drawGuides(canvas: HTMLCanvasElement, slot: PartSlot): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  ctx.save();
  const u = (v: number): number => v * S;
  ctx.lineWidth = Math.max(2, S * 0.006);
  ctx.strokeStyle = 'rgba(120, 100, 70, 0.28)';
  ctx.fillStyle = 'rgba(120, 100, 70, 0.55)';
  ctx.setLineDash([S * 0.02, S * 0.02]);
  ctx.font = `700 ${Math.round(S * 0.04)}px sans-serif`;
  ctx.textAlign = 'center';

  const side = slot.view === 'side';
  // 中心線 (正面の絵: 左右対称の目安 / 横向きの絵: 地面の目安)
  ctx.beginPath();
  if (!side || slot.kind === 'leg' || slot.kind === 'arm' || slot.kind === 'ornament') {
    ctx.moveTo(u(0.5), u(0.04));
    ctx.lineTo(u(0.5), u(0.96));
  } else {
    ctx.moveTo(u(0.04), u(0.5));
    ctx.lineTo(u(0.96), u(0.5));
  }
  ctx.stroke();

  const label = (text: string, x: number, y: number): void => {
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillText(text, u(x), u(y));
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
  switch (slot.kind) {
    case 'head':
      if (side) {
        ctx.arc(u(0.5), u(0.46), u(0.28), 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.roundRect(u(0.7), u(0.5), u(0.24), u(0.16), u(0.06)); // 鼻先
        ctx.stroke();
        dot(0.2, 0.72);
        label('首', 0.2, 0.8);
      } else {
        ctx.arc(u(0.5), u(0.46), u(0.3), 0, Math.PI * 2);
        ctx.stroke();
        dot(0.5, 0.9);
        label('首', 0.5, 0.96);
      }
      break;
    case 'body':
      if (side) {
        ctx.roundRect(u(0.1), u(0.3), u(0.8), u(0.42), u(0.16));
        ctx.stroke();
        dot(0.78, 0.4);
        label('頭 →', 0.78, 0.33);
        dot(0.2, 0.5);
        label('しっぽ', 0.2, 0.43);
        label('右が前です', 0.5, 0.9);
      } else {
        ctx.roundRect(u(0.27), u(0.12), u(0.46), u(0.76), u(0.12));
        ctx.stroke();
        dot(0.27, 0.26);
        dot(0.73, 0.26);
        label('肩', 0.5, 0.2);
        dot(0.5, 0.92);
        label('腰', 0.5, 0.98);
      }
      break;
    case 'arm':
      ctx.roundRect(u(0.41), u(0.1), u(0.18), u(0.7), u(0.09));
      ctx.stroke();
      dot(0.5, 0.1);
      label('肩', 0.5, 0.07);
      break;
    case 'leg':
      ctx.roundRect(u(0.39), u(0.1), u(0.22), u(0.76), u(0.09));
      ctx.stroke();
      dot(0.5, 0.1);
      label('付け根', 0.5, 0.07);
      break;
    case 'tail':
      if (side) {
        ctx.roundRect(u(0.1), u(0.42), u(0.8), u(0.16), u(0.08));
        ctx.stroke();
        dot(0.9, 0.5);
        label('根元', 0.9, 0.42);
      } else {
        ctx.roundRect(u(0.42), u(0.1), u(0.16), u(0.7), u(0.08));
        ctx.stroke();
        dot(0.5, 0.1);
        label('根元', 0.5, 0.07);
      }
      break;
    case 'wing':
      ctx.moveTo(u(0.1), u(0.5));
      ctx.quadraticCurveTo(u(0.4), u(0.12), u(0.92), u(0.34));
      ctx.quadraticCurveTo(u(0.78), u(0.62), u(0.42), u(0.72));
      ctx.quadraticCurveTo(u(0.2), u(0.7), u(0.1), u(0.5));
      ctx.stroke();
      dot(0.1, 0.5);
      label('根元', 0.1, 0.43);
      break;
    case 'ornament':
      ctx.moveTo(u(0.5), u(0.14));
      ctx.lineTo(u(0.66), u(0.88));
      ctx.lineTo(u(0.34), u(0.88));
      ctx.closePath();
      ctx.stroke();
      dot(0.5, 0.9);
      label('根元', 0.5, 0.97);
      break;
  }
  ctx.restore();
}

/** パーツごとの描き方の説明 (キャンバスの下に出す)。 */
export function partHint(slot: PartSlot): string {
  const common = '輪郭を線で閉じ、「塗り」で中に色を付けます';
  switch (slot.kind) {
    case 'body':
      return slot.view === 'side' ? `${common}。横から見た絵を、右向きに描きます` : `${common}。他のパーツをつなぐ目安が薄く出ています`;
    case 'head':
      return slot.view === 'side' ? '顔を描き込んでもかまいません。右向きで、首のつなぎ目が左下です' : '顔を描き込んでもかまいません。下の「首」が胴体とつながります';
    case 'arm':
      return '上の「肩」から下に伸びる腕を描きます';
    case 'leg':
      return '上の「付け根」から下に伸びる脚を描きます';
    case 'tail':
      return slot.view === 'side' ? '右端の「根元」から、左へ伸びるしっぽを描きます' : '上の「根元」から下に伸びるしっぽを描きます';
    case 'wing':
      return '左端の「根元」から、右へ広がる翼を描きます。左右の翼は自動でそろいます';
    case 'ornament':
      return '下の「根元」から上へ伸びる角や耳を描きます。頭に付きます';
  }
}
