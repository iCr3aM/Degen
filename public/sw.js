/**
 * Service Worker（PWA · 2026-10-01）
 * ===============================================================
 * 手写，不引 workbox —— 本站只有一个入口 ＋ 一堆静态行情包，规则两条就够。
 *
 * 缓存策略（**以「上传后能拿到最新版」为第一优先**）：
 *   ① `/data/…` 行情包 —— **stale-while-revalidate**：先吐缓存（秒开、离线可用），
 *      同时在后台拉一份新的写回缓存，下次进来就是最新的。行情包大且很少变，这样最划算。
 *   ② 其余同源请求（HTML / JS / CSS / manifest）—— **network-first ＋ `no-store`**：
 *      强制绕过浏览器 HTTP 缓存去取最新的。`vite.config.js` 现在给产物**加了内容哈希**
 *      （`assets/[name].[hash].js`，2026-10-01），HTML 一刷新就必然带来新 JS；这一条负责保证
 *      **`index.html` 本身**也是新的（它名字固定，是整条链上唯一没法靠改名绕开缓存的一环）。
 *      断网时退回缓存里那一份（离线仍可玩）。
 *   ③ 跨域请求一律不插手（行情源直连）。
 *
 * ⚠️ 改了本文件的缓存规则要**同时改 `CACHE` 的版本号**，否则 activate 里那段清旧缓存
 *    不会执行，玩家会卡在旧策略上。
 *    ⇒ **2026-10-01 起不再手动改**：缓存名**直接取自脚本 URL 的 `?v=`**（见下）。
 *      `main.js` 每次构建都会注册 `sw.js?v=<构建指纹>`，于是名字自动变、旧缓存自动清。
 *      原来那行「记得改 degen-v1」的约定正式作废 —— 它太容易忘，而这正是一次更新失败的经典原因。
 */

/* 缓存名 = `sw.js?v=<构建指纹>`（`main.js` 拼的）。拿不到 `?v=` 时（本地直开等）退回 `dev`。 */
const CACHE = 'degen-' + (new URL(self.location.href).searchParams.get('v') || 'dev');

/** 预缓存的应用外壳 —— 断网首次进入也能开出菜单（其余资源按需缓存） */
const SHELL = ['./', './index.html', './manifest.json'];

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
