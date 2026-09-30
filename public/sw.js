/**
 * Service Worker（PWA · 2026-10-01）
 * ===============================================================
 * 手写，不引 workbox —— 本站只有一个入口 ＋ 一堆静态行情包，规则两条就够。
 *
 * 缓存策略（**以「上传后能拿到最新版」为第一优先**）：
 *   ① `/data/…` 行情包 —— **stale-while-revalidate**：先吐缓存（秒开、离线可用），
 *      同时在后台拉一份新的写回缓存，下次进来就是最新的。行情包大且很少变，这样最划算。
 *   ② 其余同源请求（HTML / JS / CSS / manifest）—— **network-first ＋ `no-store`**：
 *      强制绕过浏览器 HTTP 缓存去取最新的。本项目 `vite.config.js` 的文件名**不带哈希**
 *      （`assets/[name].js`），所以浏览器会把旧 JS 缓存住 —— 只靠上传是拿不到新版代码的，
 *      这一条就是为此设的。断网时退回缓存里那一份（离线仍可玩）。
 *   ③ 跨域请求一律不插手（行情源直连）。
 *
 * ⚠️ 改了本文件的缓存规则要**同时改 `CACHE` 的版本号**，否则 activate 里那段清旧缓存
 *    不会执行，玩家会卡在旧策略上。
 */

const CACHE = 'degen-v1';

/** 预缓存的应用外壳 —— 断网首次进入也能开出菜单（其余资源按需缓存） */
const SHELL = ['./', './index.html', './manifest.webmanifest'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {}))   // 单个 404 不该让整个安装失败
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 跨域：不插手

  /* ① 行情包：先给缓存，后台补新的 */
  if (url.pathname.includes('/data/')) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req);
      const net = fetch(req)
        .then(res => { if (res && res.ok) cache.put(req, res.clone()); return res; })
        .catch(() => null);
      if (hit) return hit;
      const res = await net;
      return res || new Response('', { status: 504 });
    })());
    return;
  }

  /* ② 其余同源：network-first（绕 HTTP 缓存），断网退回缓存 */
  e.respondWith((async () => {
    try {
      const res = await fetch(req, { cache: 'no-store' });
      if (res && res.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return (await caches.match(req)) || (await caches.match('./index.html')) || Response.error();
    }
  })());
});
