// PV (紹介動画) のコマ撮り。開発サーバー (http://localhost:5173) で動いている本物のゲームを、1 コマずつ進めながら撮る。
//
//   npm run dev   (別の端末で。5173 番)
//   node scripts/pv/capture.mjs            → pv-out/frames/<場面>_0001.jpg …
//   python scripts/pv/encode.py            → pv-out/rakugaction-pv.mp4
//
// 録画ではなく、ゲームの時間を 1/30 秒ずつ手で進めて、そのつど画面を保存する (描画が遅い PC でも、動画はなめらか)。
// Chrome を、画面を出さない形 (headless) で起動し、開発者用の口 (DevTools Protocol) から操作する。追加のライブラリは使わない。
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = process.env.PV_BASE ?? 'http://localhost:5173';
const CHROME = process.env.CHROME ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9333;
const W = 1280;
const H = 720;
const FPS = 30;
const OUT = 'pv-out/frames';
const ONLY = process.argv[2] ?? null; // 場面の名前を渡すと、その場面だけ撮る

/** 画面の下に出す説明の文字 (場面ごと) と、撮影用の見た目の調整 */
const STYLE = `
  .demo-overlay, .rotate-hint, .debug-panel { display: none !important; }
  .title-tap { animation: none !important; }
  #pv-caption { position: fixed; left: 50%; bottom: 44px; transform: translateX(-50%); z-index: 9999; padding: 12px 30px; border-radius: 999px;
    background: rgba(20, 28, 44, 0.78); color: #fff; font: 900 34px/1.3 system-ui, 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', 'Meiryo', sans-serif;
    letter-spacing: 0.04em; white-space: nowrap; box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
  #pv-caption b { color: #ffd23f; }
`;

/** 場面。setup = 撮る前の準備 (ページの中で実行。Promise を返してよい)、step = 1 コマ進める、frames = コマ数 */
const SHOTS = [
  {
    name: '1_title',
    url: '/',
    frames: 75,
    caption: '',
    setup: `(async () => { for (let i = 0; i < 80 && !document.querySelector('.title-screen.gate'); i++) await new Promise(r => setTimeout(r, 100)); window.__f = 0; })()`,
    step: `(() => { window.__f++; const t = document.querySelector('.title-tap'); if (t) t.style.opacity = String(0.6 + 0.4 * Math.cos(window.__f / 30 * Math.PI * 1.2)); })()`,
  },
  {
    name: '2_draw',
    url: '/?demo=draw',
    frames: 225,
    caption: '描いた<b>ラクガキ</b>が、そのまま <b>3D</b> キャラクターに',
    setup: `(async () => { const rg = window.__rg; for (let i = 0; i < 100 && !(rg.screen && rg.screen.plan); i++) await new Promise(r => setTimeout(r, 100)); const sc = rg.screen; sc.loop = () => {}; window.__sc = sc; })()`,
    // 3.1 倍速 (線を引く約 21 秒 + できあがり) を 7.5 秒に
    step: `(() => { const sc = window.__sc; for (let k = 0; k < 3; k++) sc.plan.step(1 / 30 * 1.033); sc.preview && sc.preview.render(1 / 30); })()`,
  },
  {
    name: '3_play',
    url: '/?demo=play',
    frames: 210,
    caption: '描いたパーツで、<b>技</b>が変わる',
    setup: `(async () => { const rg = window.__rg; for (let i = 0; i < 150 && !rg.session; i++) await new Promise(r => setTimeout(r, 100)); const s = rg.session; s.scene.stop(); clearTimeout(rg.demoTimer); for (let i = 0; i < 600 && s.phase !== 'playing'; i++) s.scene.tick(1 / 60); window.__s = s; })()`,
    step: `window.__s.scene.tick(1 / 30)`,
  },
  {
    name: '4_combo',
    url: '/?doodle=asura&stage=stage1',
    frames: 120,
    caption: '腕が 3 本以上なら <b>フック → フック → アッパー</b>',
    setup: `(async () => { const rg = window.__rg; for (let i = 0; i < 150 && !rg.session; i++) await new Promise(r => setTimeout(r, 100)); const s = rg.session, sc = s.scene; sc.stop(); for (let i = 0; i < 600 && s.phase !== 'playing'; i++) sc.tick(1 / 60);
      sc.overridePerStep = true; let n = 0;
      sc.inputOverride = (si) => { n++; si.moveX = 0; si.moveZ = 0; si.jumpPressed = false; si.jumpHeld = false; si.actionHeld = false; si.actionPressed = n > 20; };
      window.__s = s; window.__yaw = sc.sim.player.yaw; })()`,
    // カメラを、ななめ前へゆっくり回す (技の動きが見える向き)
    step: `(() => { const sc = window.__s.scene; window.__k = (window.__k || 0) + 1; sc.camera.yaw = window.__yaw + 0.38 - window.__k * 0.004; sc.camera.pitch = 0.16; sc.camera.dist = 4.2; sc.tick(1 / 30); })()`,
  },
  {
    name: '5_boss',
    url: '/?doodle=chimera&stage=stage5',
    frames: 190,
    caption: '塔の頂上で待つ <b>星よみの守り神</b>',
    setup: `(async () => { const rg = window.__rg; for (let i = 0; i < 200 && !rg.session; i++) await new Promise(r => setTimeout(r, 100)); const s = rg.session, sc = s.scene, sim = sc.sim; sc.stop(); for (let i = 0; i < 600 && s.phase !== 'playing'; i++) sc.tick(1 / 60);
      for (const k of sim.stage.pickups.slice(0, 5)) sim.collected.add(k.id); s.syncPickups();
      sim.player.placeFeet(2.5, 30.1, -8.6, 0); sc.camera.snapTo(sim, 0);
      await rg.autoplay('main'); sc.overridePerStep = true;
      // 目を覚まして、最初の前ぶれが始まる少し前まで進めてから撮る
      for (let i = 0; i < 600 && !sim.boss.active; i++) sc.tick(1 / 60);
      sim.boss.hp = 11; window.__s = s; })()`,
    step: `window.__s.scene.tick(1 / 30)`,
  },
  {
    name: '6_end',
    url: '/',
    frames: 1,
    caption: '',
    setup: `(async () => { for (let i = 0; i < 80 && !document.querySelector('.title-screen'); i++) await new Promise(r => setTimeout(r, 100));
      const d = document.createElement('div');
      d.style.cssText = "position:fixed;inset:0;z-index:99999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;background:radial-gradient(ellipse 60% 70% at 50% 50%, rgba(255,250,238,0.9) 0%, rgba(255,250,238,0.55) 60%, rgba(255,250,238,0.1) 100%), url('/title-bg.webp') center/cover;font-family:system-ui,'Yu Gothic UI','Meiryo',sans-serif;text-align:center;";
      d.innerHTML = '<img src="/icon-512.png" style="width:190px;height:190px;border-radius:42px;box-shadow:0 10px 30px rgba(0,0,0,0.25)">'
        + '<div style="font-size:76px;font-weight:900;color:#ff7a3d;letter-spacing:0.04em;text-shadow:0 0 16px #fff,4px 4px 0 #fff,-3px -3px 0 #fff,3px -3px 0 #fff,-3px 3px 0 #fff">ラクガキアクション</div>'
        + '<div style="font-size:34px;font-weight:900;color:#3a2c14;text-shadow:0 0 8px #fff,0 0 4px #fff">ブラウザですぐ遊べる・無料・インストール不要</div>'
        + '<div style="margin-top:6px;padding:12px 30px;border-radius:999px;background:#14202e;color:#fff;font-size:30px;font-weight:800;letter-spacing:0.02em">cadmium2525.github.io/rakugaction</div>';
      document.body.appendChild(d);
      await new Promise(r => { const im = d.querySelector('img'); if (im.complete) r(); else im.onload = r; });
      await new Promise(r => setTimeout(r, 400)); })()`,
    step: `0`,
  },
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

    mkdirSync(OUT, { recursive: true });
    for (const shot of SHOTS) {
      if (ONLY && shot.name !== ONLY) continue;
      const t0 = Date.now();
      await send('Page.navigate', { url: BASE + shot.url });
      await sleep(1500);
      // 開発用の入口 (window.__rg) が出るまで待つ
      for (let i = 0; i < 100; i++) {
        if (await evaluate('typeof window.__rg === "object" && document.readyState === "complete"')) break;
        await sleep(100);
      }
      await evaluate(`(() => { const st = document.createElement('style'); st.textContent = ${JSON.stringify(STYLE)}; document.head.appendChild(st);
        const c = document.createElement('div'); c.id = 'pv-caption'; c.innerHTML = ${JSON.stringify(shot.caption)}; if (${JSON.stringify(shot.caption)}) document.body.appendChild(c); })()`);
      await evaluate(shot.setup);
      for (let f = 1; f <= shot.frames; f++) {
        await evaluate(shot.step);
        const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 93 });
        writeFileSync(`${OUT}/${shot.name}_${String(f).padStart(4, '0')}.jpg`, Buffer.from(data, 'base64'));
      }
      console.log(`${shot.name}: ${shot.frames} コマ (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
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
  console.log(`fps=${FPS}`);
}

await main();
