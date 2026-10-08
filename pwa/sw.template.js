/*
 * オフラインで遊べるようにする Service Worker (ビルドの時に、版の目印とファイルの一覧を埋めて dist/sw.js にする: vite.config.ts の offlineWorker)。
 *
 *  - 入れた時: ゲームのファイル (HTML・JS・CSS・アイコン・デモの絵) を、全部まとめて取っておく。1 つでも取れなければ、入れない (中途半端な状態で動かさない)
 *  - ページ (HTML): つながっていれば新しい物を取りにいき、だめなら取っておいた物を出す (つながっている時は、すぐ新しい版になる)
 *  - 名前に目印が付いたファイル (assets/…): 取っておいた物を出す (中身が変われば名前も変わるので、古い物を出すことはない)
 *  - ランキングの設定 (ranking-config.json) と、ほかのサイト (Firebase・Google) への通信には、手を出さない
 *    → オフラインでは、ランキングだけが「読み込めませんでした」になり、ゲームは遊べる
 *  - 管理者アプリ (/admin/) と音の道具 (/daw/) は、取っておかない (つながっている時だけ使う)
 */
const VERSION = '%VERSION%';
const CACHE = `rakugaction-${VERSION}`;
const ASSETS = [/*ASSETS*/];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('rakugaction-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** このリクエストは、ゲームのページか (管理者アプリ・音の道具ではない) */
function isGamePage(url) {
  const rel = url.pathname.slice(new URL(self.registration.scope).pathname.length);
  return rel === '' || rel === 'index.html';
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.endsWith('/ranking-config.json')) return;

  if (req.mode === 'navigate') {
    if (!isGamePage(url)) return;
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            event.waitUntil(caches.open(CACHE).then((c) => c.put('./', copy)));
          }
          return res;
        })
        .catch(() => caches.open(CACHE).then((c) => c.match('./')).then((hit) => hit || Response.error())),
    );
    return;
  }

  event.respondWith(
    caches
      .open(CACHE)
      .then((c) => c.match(req, { ignoreSearch: false }))
      .then((hit) => hit || fetch(req)),
  );
});
