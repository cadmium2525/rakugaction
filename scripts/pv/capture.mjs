// PV (紹介動画) のコマ撮り。開発サーバー (http://localhost:5173) で動いている本物のゲームを、1 コマずつ進めながら撮る。
//
//   npm run dev   (別の端末で。5173 番)
//   node scripts/pv/capture.mjs            → pv-out/frames/<場面>_0001.jpg …
//   python scripts/pv/encode.py            → pv-out/rakugaction-pv.mp4
//
// 録画ではなく、ゲームの時間を 1/30 秒ずつ手で進めて、そのつど画面を保存する (描画が遅い PC でも、動画はなめらか)。
// Chrome を、画面を出さない形 (headless) で起動し、開発者用の口 (DevTools Protocol) から操作する。追加のライブラリは使わない。
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.PV_BASE ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const W = 1280;
const H = 720;
const OUT = 'pv-out/frames';

/** 画面の下に出す説明の文字と、撮影用の見た目の調整 */
const STYLE = `
  .demo-overlay, .rotate-hint, .debug-panel, .birth-buttons { display: none !important; }
  .title-tap { animation: none !important; }
  #pv-caption { position: fixed; left: 50%; bottom: 44px; transform: translateX(-50%); z-index: 9999; padding: 12px 30px; border-radius: 999px;
    background: rgba(20, 28, 44, 0.78); color: #fff; font: 900 34px/1.3 system-ui, 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', sans-serif;
    letter-spacing: 0.04em; white-space: nowrap; box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
  #pv-caption b { color: #ffd23f; }
`;

/** どの場面でも最初にやること: 画質を高くして、解像度の自動調整を止める (コマ撮りは遅いので、「重い端末」と判断されて解像度が下がってしまう) */
const HQ = `(() => { const rg = window.__rg; try { rg.setQualitySetting('high'); } catch (e) {} if (rg.host) rg.host.adaptResolution = () => {}; })()`;
/** 操作を、台本 (window.__in) のとおりに入れる。__in = { x, z, action: 1 なら、次の計算で ACTION を押す } */
// ゲームは、GO! の瞬間に「操作の差し替え」を session.botInput に入れ直す。だから、scene だけでなく session.botInput にも入れておく
// (scene だけに入れると、GO! で外れて、キャラクターが 1 歩も動かないまま撮ってしまう = 実際にやった失敗)
const SCRIPTED = `(() => { const s = window.__rg.session, sc = s.scene; window.__in = { x: 0, z: 0, action: 0 };
  const fn = (si) => { const i = window.__in; si.moveX = i.x; si.moveZ = i.z; si.jumpPressed = false; si.jumpHeld = false; si.actionHeld = false; si.actionPressed = i.action > 0; };
  s.botInput = fn; if (s.phase === 'playing') { sc.inputOverride = fn; sc.overridePerStep = true; } })()`;

/** ボスをシルエットにする: 体の色を黒くする (光の輪と結晶は、光ったまま)。画面も暗くして、ふちを黒くする */
const SILHOUETTE = `(() => { const sc = window.__rg.session.scene; const bv = sc.view.stageView.bossView; bv.mats.length = 0;
  bv.rig.root.traverse((o) => { const ms = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of ms) { if (m.color) m.color.setRGB(0.02, 0.02, 0.05); if (m.emissive) m.emissive.setRGB(0, 0, 0); if (m.map) m.map = null;
      if (m.uniforms) for (const u of Object.values(m.uniforms)) if (u && u.value && u.value.isColor) u.value.setRGB(0, 0, 0); m.needsUpdate = true; } });
  const st = document.createElement('style'); st.textContent = '.hud, .minimap { display: none !important; } canvas { filter: brightness(0.6) saturate(0.85) contrast(1.1); }'; document.head.appendChild(st);
  const vg = document.createElement('div'); vg.style.cssText = 'position:fixed;inset:0;z-index:9000;pointer-events:none;background:radial-gradient(ellipse 70% 75% at 50% 45%, rgba(0,0,0,0) 38%, rgba(0,0,0,0.8) 100%)'; document.body.appendChild(vg); })()`;

/** 締めの 1 枚 (アプリの紹介) */
const END_CARD = `(async () => { for (let i = 0; i < 80 && !document.querySelector('.title-screen'); i++) await new Promise(r => setTimeout(r, 100));
  const d = document.createElement('div');
  d.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:radial-gradient(ellipse 60% 70% at 50% 50%, rgba(255,250,238,0.9) 0%, rgba(255,250,238,0.55) 60%, rgba(255,250,238,0.1) 100%), url('/title-bg.webp') center/cover;font-family:system-ui,'Yu Gothic UI','Meiryo',sans-serif;text-align:center;";
  d.innerHTML = '<img src="/icon-512.png" style="width:190px;height:190px;border-radius:42px;box-shadow:0 10px 30px rgba(0,0,0,0.25)">'
    + '<div style="font-size:76px;font-weight:900;color:#ff7a3d;letter-spacing:0.04em;text-shadow:0 0 16px #fff,4px 4px 0 #fff,-3px -3px 0 #fff,3px -3px 0 #fff,-3px 3px 0 #fff">ラクガキアクション</div>'
    + '<div style="font-size:34px;font-weight:900;color:#3a2c14;text-shadow:0 0 8px #fff,0 0 4px #fff">ブラウザですぐ遊べる・無料・インストール不要</div>'
    + '<div style="margin-top:6px;padding:12px 30px;border-radius:999px;background:#14202e;color:#fff;font-size:30px;font-weight:800;letter-spacing:0.02em">cadmium2525.github.io/rakugaction</div>';
  document.body.appendChild(d);
  await new Promise(r => { const im = d.querySelector('img'); if (im.complete) r(); else im.onload = r; });
  await new Promise(r => setTimeout(r, 400)); })()`;

/**
 * 場面 (ユーザーの台本, 2026-10-10): ドラゴンの絵を描く → 絵からキャラクターが生まれる → そのドラゴンで操作開始 →
 * アクションの紹介 (コンボ・幅跳び) → ボス戦をシルエットでにおわせる → アプリの紹介。
 * url = 開くページ (null = 前の場面のページのまま続ける)、setup = 撮る前の準備、step = 1 コマ進める、frames = コマ数
 */
const SHOTS = [
  {
    name: '1_draw',
    url: '/?demo=draw',
    frames: 216,
    caption: '<b>ラクガキ</b>を描くと…',
    setup: `(async () => { const rg = window.__rg; for (let i = 0; i < 100 && !(rg.screen && rg.screen.plan); i++) await new Promise(r => setTimeout(r, 100)); const sc = rg.screen; sc.loop = () => {}; window.__sc = sc; })()`,
    // 約 3 倍速 (線を引く 21 秒を 7 秒に)。できあがった所で終わる
    step: `(() => { const sc = window.__sc; for (let k = 0; k < 3; k++) sc.plan.step(1 / 30); sc.preview && sc.preview.render(1 / 30); })()`,
  },
  {
    name: '2_birth',
    url: '/?debug=1',
    frames: 150,
    caption: 'そのまま <b>3D キャラクター</b>に',
    setup: `(async () => { const rg = window.__rg; for (let i = 0; i < 80 && !document.querySelector('.title-screen'); i++) await new Promise(r => setTimeout(r, 100));
      rg.started = true; const mod = await import('/src/app/demo.ts'); const d = await mod.loadDemoDrawing('./'); rg.drawing = d;
      await rg.showBirth(d); ${HQ}; const scr = rg.screen; scr.loop = () => {}; const inp = document.querySelector('.name-input'); if (inp) inp.value = 'ドラゴン'; window.__scr = scr; })()`,
    step: `window.__scr.tick(1 / 30)`,
  },
  {
    name: '3_start',
    url: null,
    frames: 110,
    caption: '自分のキャラクターで、<b>冒険</b>へ',
    setup: `(async () => { const rg = window.__rg; rg.screen.opts.onPlay('ドラゴン'); for (let i = 0; i < 60 && !rg.profile.selected; i++) await new Promise(r => setTimeout(r, 50));
      await rg.startStage('stage1'); ${HQ}; const s = rg.session; s.scene.stop(); ${SCRIPTED}; window.__s = s; })()`,
    // READY → GO のあと、北へ走り出す
    step: `(() => { const s = window.__s; window.__in.z = s.phase === 'playing' ? 1 : 0; s.scene.tick(1 / 30); })()`,
  },
  {
    name: '4_combo',
    url: null,
    frames: 115,
    caption: '描いたパーツで、<b>コンボ</b>が変わる',
    setup: `(async () => { const sc = window.__s.scene; window.__in.z = 0; window.__k = 0; window.__yaw = sc.sim.player.yaw; })()`,
    // 止まって ACTION を連打。カメラを、前ななめへ回して近づける (技の動きが見える向き)
    step: `(() => { const sc = window.__s.scene; window.__k++; const k = Math.min(1, window.__k / 20); sc.camera.yaw = window.__yaw + Math.PI * (1 - k) + 0.45 * k; sc.camera.pitch = 0.42 - 0.24 * k; sc.camera.dist = 7.5 - 2.3 * k;
      window.__in.action = window.__k > 12 ? 1 : 0; sc.tick(1 / 30); })()`,
  },
  {
    name: '5_dive',
    url: null,
    frames: 110,
    caption: '走りながら ACTION で <b>幅跳び</b>',
    setup: `(async () => { const sc = window.__s.scene; window.__in.action = 0; window.__in.z = 1; window.__k = 0; sc.camera.dist = 7.5; sc.camera.pitch = 0.36; sc.camera.snapTo(sc.sim, sc.sim.player.yaw); for (let i = 0; i < 30; i++) sc.tick(1 / 60); })()`,
    // 地面を走っている時に、決まった間隔で ACTION (前に敵がいなければ、幅跳びになる)
    step: `(() => { const sc = window.__s.scene; window.__k++; const p = sc.sim.player; window.__in.action = window.__k % 24 === 6 && p.grounded ? 1 : 0; sc.tick(1 / 30); window.__in.action = 0; if (p.attackSerial !== window.__ser) { window.__ser = p.attackSerial; window.__moves = (window.__moves || '') + p.attackMove + ' '; if (p.attackMove === 'dive') window.__dives = (window.__dives || 0) + 1; } })()`,
  },
  {
    name: '6_boss',
    url: '/?doodle=normal&stage=stage5',
    frames: 150,
    caption: '塔の頂上で、<b>何か</b>が待っている…',
    setup: `(async () => { const rg = window.__rg; for (let i = 0; i < 200 && !rg.session; i++) await new Promise(r => setTimeout(r, 100)); ${HQ}; const s = rg.session, sc = s.scene, sim = sc.sim; sc.stop(); for (let i = 0; i < 600 && s.phase !== 'playing'; i++) sc.tick(1 / 60);
      for (const k of sim.stage.pickups.slice(0, 5)) sim.collected.add(k.id);
      sim.player.placeFeet(0.5, 30.1, -7.5, 0); sc.overridePerStep = true; sc.inputOverride = (si) => { si.moveX = 0; si.moveZ = 0; si.jumpPressed = false; si.jumpHeld = false; si.actionPressed = false; si.actionHeld = false; };
      sc.view.player.group.visible = false;
      for (let i = 0; i < 900 && !(sim.boss.state === 'idle' && sim.boss.t > 0.2); i++) { sim.invuln = 99999; sc.tick(1 / 60); }
      ${SILHOUETTE}; sc.camera.update = () => {}; window.__s = s; window.__k = 0; })()`,
    // 低い位置から見上げて、ゆっくり近づく
    step: `(() => { const sc = window.__s.scene, sim = sc.sim; window.__k++; const k = window.__k / 150; sim.invuln = 99999; const p = sc.camera.pose; p.x = 2.2 - 1.0 * k; p.y = 30.8 + 0.2 * k; p.z = -9.6 + 2.8 * k; p.tx = 0; p.ty = 33.0; p.tz = 0; sc.tick(1 / 30); })()`,
  },
  { name: '7_end', url: '/', frames: 1, caption: '', setup: END_CARD, step: `0` },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = join(tmpdir(), `rakugaction-pv-${Date.now()}`);
  const chrome = spawn(CHROME, [`--remote-debugging-port=${PORT}`, '--headless=new', `--window-size=${W},${H}`, `--user-data-dir=${profile}`, '--hide-scrollbars', '--mute-audio', '--no-first-run', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
  let ws;
  try {
    let target = null;
    for (let i = 0; i < 50 && !target; i++) {
      await sleep(200);
      try {
        const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
        target = list.find((t) => t.type === 'page') ?? null;
      } catch {
        // まだ起動していない: 少し待って、もう一度
      }
    }
    if (!target) throw new Error('Chrome に接続できませんでした');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = rej;
    });
    let seq = 0;
    const waiting = new Map();
    ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && waiting.has(m.id)) {
        const { res, rej } = waiting.get(m.id);
        waiting.delete(m.id);
        if (m.error) rej(new Error(JSON.stringify(m.error)));
        else res(m.result);
      }
    };
    const send = (method, params = {}) =>
      new Promise((res, rej) => {
        const id = ++seq;
        waiting.set(id, { res, rej });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const evaluate = async (expression) => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`ページの中でエラー: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value;
    };
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });

    // 前に撮ったコマを消す (場面の数や名前が変わった時に、古いコマが混ざらないように)
    mkdirSync(OUT, { recursive: true });
    for (const f of readdirSync(OUT)) if (f.endsWith('.jpg')) rmSync(join(OUT, f));

    for (const shot of SHOTS) {
      const t0 = Date.now();
      if (shot.url) {
        await send('Page.navigate', { url: BASE + shot.url });
        await sleep(1500);
        // 開発用の入口 (window.__rg) が出るまで待つ
        for (let i = 0; i < 100; i++) {
          if (await evaluate('typeof window.__rg === "object" && document.readyState === "complete"')) break;
          await sleep(100);
        }
        await evaluate(`(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(STYLE)}; document.head.appendChild(st); })()`);
      }
      await evaluate(`(() => { const old = document.getElementById('pv-caption'); if (old) old.remove(); const html = ${JSON.stringify(shot.caption)}; if (!html) return;
        const c = document.createElement('div'); c.id = 'pv-caption'; c.innerHTML = html; document.body.appendChild(c); })()`);
      await evaluate(shot.setup);
      for (let f = 1; f <= shot.frames; f++) {
        await evaluate(shot.step);
        const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
        writeFileSync(`${OUT}/${shot.name}_${String(f).padStart(4, '0')}.jpg`, Buffer.from(data, 'base64'));
      }
      // 幅跳びの場面は、本当に幅跳びが出たか (前に敵がいると、その場の技になる) を数えて知らせる
      const note = shot.name === '5_dive' ? `  幅跳び ${await evaluate('window.__dives || 0')} 回 (出た技: ${await evaluate('window.__moves || ""')}) ${await evaluate('(() => { const s = window.__s, p = s.scene.sim.player; return JSON.stringify({ combo: p.params.combo, grounded: p.grounded, cd: p.attackCooldown, ci: p.comboIndex, serial: p.attackSerial, phase: s.phase, paused: s.scene.paused, z: p.pos.z, hp: s.scene.sim.hp, inp: window.__in, ov: String(s.scene.inputOverride).slice(0, 60) }); })()')}` : '';
      console.log(`${shot.name}: ${shot.frames} コマ (${((Date.now() - t0) / 1000).toFixed(1)} 秒)${note}`);
    }
  } finally {
    try {
      ws?.close();
    } catch {
      // 閉じられなくても、下で Chrome ごと終わらせる
    }
    chrome.kill();
    await sleep(500);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // 一時フォルダが消せなくても、動画づくりには関係ない
    }
  }
}

await main();
