import './ui/style.css';
import './ui/game.css';
import { App } from './app/app';

const root = document.getElementById('app');
if (!root) throw new Error('#app not found');

const app = new App(root);
void app.boot();

// 開発・QA 用フック (?debug=1 または dev サーバーのみ)
if (import.meta.env.DEV || new URLSearchParams(location.search).has('debug')) {
  (window as unknown as { __rg: App }).__rg = app;
}

// オフラインでも遊べるように、ゲームのファイルを端末に取っておく (公開版だけ。開発サーバーでは入れない: 古いファイルが出て、直した物が見えなくなる)
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((e: unknown) => {
      // 入れられない環境 (非対応・プライベートブラウズなど) では、今までどおりオンラインで遊べる
      console.warn('offline support unavailable', e);
    });
  });
}
