import { altModeOf } from '../../drawing/model';
import type { PartSlot } from '../../drawing/model';
import type { DrawingRaster } from '../../drawing/raster';

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
    case 'decal':
      ctx.rect(u(0.04), u(0.04), u(0.92), u(0.92)); // 貼る絵の範囲 (この中に描く)
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(u(0.5), u(0.44));
      ctx.lineTo(u(0.5), u(0.56));
      ctx.moveTo(u(0.44), u(0.5));
      ctx.lineTo(u(0.56), u(0.5));
      ctx.stroke();
      label('貼る場所の中心', 0.5, 0.62);
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
      return slot.view === 'side' ? '右向きで、首のつなぎ目が左下です。顔は「＋足す」の「もよう」で貼ると細かく描けます' : '下の「首」が胴体とつながります。顔は「＋足す」の「もよう」で貼ると細かく描けます (ここに描いてもかまいません)';
    case 'arm':
      return '上の「肩」から下に伸びる腕を描きます';
    case 'leg':
      return '上の「付け根」から下に伸びる脚を描きます';
    case 'tail':
      return slot.view === 'side' ? '右端の「根元」から、左へ伸びるしっぽを描きます' : '上の「根元」から下に伸びるしっぽを描きます';
    case 'wing':
      return '左端の「根元」から、右へ広がる翼を描きます。左右の翼は自動でそろいます';
    case 'ornament':
      return '下の「根元」から上へ伸びる角や耳を描きます。頭に付きます (「胴体に」を選ぶと、背びれや甲羅のように胴体に付きます)';
    case 'decal':
      return '頭や胴体の表面にそのまま貼る絵です (顔・縞・ぶち・柄)。立体にならないので、紙いっぱいに細かく描けます。「貼る位置」「大きさ」で場所と大きさを決めます';
  }
}

/** もう一つの向きの絵の名前 (ボタン・タブに出す) */
export function altLabel(slot: PartSlot): string {
  if (altModeOf(slot.kind, slot.view) === 'col') return '上から見た絵';
  return slot.view === 'front' ? '横から見た絵' : '正面から見た絵';
}

/** 1 枚目の絵の名前 */
export function mainLabel(slot: PartSlot): string {
  return slot.view === 'front' ? '正面から見た絵' : '横から見た絵';
}

/**
 * もう一つの向きの絵のページの下書き: 1 枚目の絵をうすく映し (高さ・横の位置をそろえるため)、厚みの中心線と、前・後ろの向きを示す。
 * 1 枚目の絵の上端・下端 (または左端・右端) に点線を引く。
 */
export function drawAltGuides(canvas: HTMLCanvasElement, slot: PartSlot, primary: DrawingRaster | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  const mode = altModeOf(slot.kind, slot.view);
  ctx.save();
  // 1 枚目の絵 (うすく)
  let x0 = S;
  let y0 = S;
  let x1 = 0;
  let y1 = 0;
  if (primary) {
    const tmp = document.createElement('canvas');
    tmp.width = primary.res;
    tmp.height = primary.res;
    tmp.getContext('2d')?.putImageData(new ImageData(primary.rgba, primary.res, primary.res), 0, 0);
    ctx.globalAlpha = 0.2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, S, S);
    ctx.globalAlpha = 1;
    const m = primary.mask();
    for (let y = 0; y < primary.res; y++) {
      for (let x = 0; x < primary.res; x++) {
        if (!m[y * primary.res + x]) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const k = S / primary.res;
    x0 *= k;
    x1 = (x1 + 1) * k;
    y0 *= k;
    y1 = (y1 + 1) * k;
  }
  ctx.lineWidth = Math.max(2, S * 0.006);
  ctx.strokeStyle = 'rgba(120, 100, 70, 0.4)';
  ctx.fillStyle = 'rgba(120, 100, 70, 0.7)';
  ctx.setLineDash([S * 0.02, S * 0.02]);
  ctx.font = `700 ${Math.round(S * 0.04)}px sans-serif`;
  ctx.textAlign = 'center';
  const line = (ax: number, ay: number, bx: number, by: number): void => {
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  };
  const label = (text: string, x: number, y: number): void => {
    ctx.save();
    ctx.setLineDash([]);
    ctx.fillText(text, x, y);
    ctx.restore();
  };
  if (mode === 'row') {
    line(S * 0.5, S * 0.03, S * 0.5, S * 0.97); // 厚みの中心 (奥行きの 0)
    if (primary && y1 > y0) {
      line(S * 0.03, y0, S * 0.97, y0); // 1 枚目の絵の上端・下端 (高さをそろえる)
      line(S * 0.03, y1, S * 0.97, y1);
    }
    if (slot.view === 'front') {
      label('前 →', S * 0.82, S * 0.06);
      label('← 後ろ', S * 0.18, S * 0.06);
    } else {
      label('キャラクターの左 →', S * 0.76, S * 0.06);
      label('← 右', S * 0.14, S * 0.06);
    }
    label('中心', S * 0.5, S * 0.99);
  } else {
    line(S * 0.03, S * 0.5, S * 0.97, S * 0.5);
    if (primary && x1 > x0) {
      line(x0, S * 0.03, x0, S * 0.97); // 1 枚目の絵の左端・右端 (横の位置をそろえる)
      line(x1, S * 0.03, x1, S * 0.97);
    }
    if (slot.kind === 'wing') {
      label('↑ 前', S * 0.5, S * 0.06);
      label('後ろ ↓', S * 0.5, S * 0.97);
    } else {
      label('前 →', S * 0.9, S * 0.45);
      label('キャラクターの左が上', S * 0.5, S * 0.06);
    }
  }
  ctx.restore();
}

/** もう一つの向きの絵のページの説明 (短く: 低い画面では紙の上に出す) */
export function altHint(slot: PartSlot): string {
  const mode = altModeOf(slot.kind, slot.view);
  if (mode === 'col') {
    return slot.kind === 'wing'
      ? '翼を上から見た形 (上が前)。うすく映る 1 枚目と、横の位置をそろえます。後ろへそる翼は、下へ曲げて描きます'
      : 'しっぽを上から見た形 (右が前)。うすく映る 1 枚目と、横の位置をそろえます';
  }
  return slot.view === 'front'
    ? '横から見た形を右向きで。うすく映る 1 枚目と高さをそろえます。前かがみ・おなかの出っぱりはここで形にします'
    : '正面から見た形を。うすく映る 1 枚目と高さをそろえます。胸の幅・たてがみの広がりはここで形にします';
}

/** 反対側から見た絵の名前 */
export function backLabel(slot: PartSlot): string {
  return slot.view === 'front' ? '後ろから見た絵' : '反対側から見た絵';
}

/**
 * 反対側から見た絵のページの下書き: 1 枚目の絵を、左右反転してうすく映す (後ろから見ると左右が逆になる)。
 * 同じ大きさ・同じ場所に、後ろから見たまま描く。
 */
export function drawBackGuides(canvas: HTMLCanvasElement, primary: DrawingRaster | null): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  if (primary) {
    const tmp = document.createElement('canvas');
    tmp.width = primary.res;
    tmp.height = primary.res;
    tmp.getContext('2d')?.putImageData(new ImageData(primary.rgba, primary.res, primary.res), 0, 0);
    ctx.save();
    ctx.translate(S, 0);
    ctx.scale(-1, 1);
    ctx.globalAlpha = 0.22;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(tmp, 0, 0, S, S);
    ctx.restore();
  }
  ctx.save();
  ctx.lineWidth = Math.max(2, S * 0.006);
  ctx.strokeStyle = 'rgba(120, 100, 70, 0.4)';
  ctx.setLineDash([S * 0.02, S * 0.02]);
  ctx.beginPath();
  ctx.moveTo(S * 0.5, S * 0.04);
  ctx.lineTo(S * 0.5, S * 0.96);
  ctx.stroke();
  ctx.restore();
}

export function backHint(slot: PartSlot): string {
  return slot.view === 'front'
    ? '後ろから見たまま、同じ大きさ・場所に描きます (1 枚目を左右反転してうすく映しています)。描かない所は、1 枚目の細かい描き込みを消した絵になります'
    : '反対側 (左向き) から見たまま、同じ大きさ・場所に描きます。描かない所は、1 枚目と同じ絵になります';
}
