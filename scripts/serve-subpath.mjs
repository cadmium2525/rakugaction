// GitHub Pages 風の確認用サーバー: ビルド済みの dist を「/<リポジトリ名>/」のサブパスだけで配信する。
// それ以外のパスは 404 を返すので、`/assets/…` のような絶対パスの取りこぼし (Pages では動かない) を検出できる。
//
//   npm run build && npm run preview:pages      → http://localhost:8099/rakugaction/
//   環境変数: PORT (既定 8099) / BASE (既定 /rakugaction/)
// リクエストの記録は /__log で見られる (200/404 の一覧)。
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const root = path.resolve('dist');
const base = process.env.BASE ?? '/rakugaction/';
const port = Number(process.env.PORT ?? 8099);
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.wasm': 'application/wasm',
};
const log = [];

if (!fs.existsSync(root)) {
  console.error('dist/ がありません。先に `npm run build` を実行してください。');
  process.exit(1);
}

http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/__log') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(log));
      return;
    }
    let status = 404;
    let body = 'not found';
    let type = 'text/plain';
    if (url.pathname.startsWith(base)) {
      const rel = decodeURIComponent(url.pathname.slice(base.length)) || 'index.html';
      const file = path.join(root, rel);
      if (file.startsWith(root) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        status = 200;
        body = fs.readFileSync(file);
        type = types[path.extname(file)] ?? 'application/octet-stream';
      }
    }
    log.push(`${status} ${url.pathname}`);
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache' });
    res.end(body);
  })
  .listen(port, () => console.log(`serving ${root} at http://localhost:${port}${base}`));
