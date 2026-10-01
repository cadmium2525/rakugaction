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
