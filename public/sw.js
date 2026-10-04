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

/* ⚠️ P0-4（2026-10-04 审计）：**必须把构建产物 `assets/*` 也预缓存**。
   病根：`vite.config.js` 给产物加了内容哈希（`assets/[name].[hash].js`，2026-10-01），
   而 `SHELL` 里那张写死的清单**不可能含哈希名** ⇒ 首访时装进去的只有 HTML / manifest。
   首次访问的那批 `assets/*` 要靠下面 fetch 处理器「网络成功后再写缓存」补上，可它
   **不覆盖首屏在 SW 接管之前就已发出的请求**（`clients.claim()` 只能从下一次导航起生效），
   于是「装好 → 立刻断网 → 刷新」时 HTML 出来了、JS/CSS 拿不到 ⇒ **白屏**。
   修法：安装时现读 `index.html`，把里面引用的 `assets/*` 一并 `cache.add`（名字从 HTML 解析，
   不写死）；单个资源失败不该拖垮安装。 */
async function precacheAssets(cache) {
  try {
    const res = await fetch('./index.html', { cache: 'no-store' });
    if (!res || !res.ok) return;
    const html = await res.text();
    const base = new URL('./index.html', self.location.href);
    const urls = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
      .map(m => m[1])
      .filter(u => u.includes('assets/') && !/^(?:[a-z]+:)?\/\//i.test(u))
      .map(u => new URL(u, base).href);
    /* T10（2026-10-04 审计）：`manifest.json` 里声明的 icon **不在** HTML 的 `src/href` 里
       ⇒ 保险箱里从来没有图标数据 ⇒ 首访断网后「添加到主屏」拿到的是一个 404 图标。
       这里把 manifest 的 `icons[].src` 一并解析进来（名字同样不写死，随 manifest 走）。 */
    try {
      const mres = await fetch('./manifest.json', { cache: 'no-store' });
      if (mres && mres.ok) {
        const man = await mres.json();
        const mbase = new URL('./manifest.json', self.location.href);
        for (const ic of (man.icons || [])) {
          if (ic && ic.src) urls.push(new URL(ic.src, mbase).href);
        }
      }
    } catch { /* manifest 拉不到 / 解析失败：不拖垮安装，退回按需缓存 */ }
    await Promise.all(urls.map(u => cache.add(u).catch(() => {})));
  } catch { /* 拉不到 index.html 就退回按需缓存（fetch 处理器仍会在联网时补上） */ }
}

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(async c => {
        await c.addAll(SHELL).catch(() => {});   // 单个 404 不该让整个安装失败
        await precacheAssets(c);                  // ＋ 解析 HTML 里的哈希产物一起预缓存
      })
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
        /* T9（2026-10-04 审计）：`cache.put` 是异步的，未 `catch` 时一旦写失败（配额满 / 请求被截断）
           就产生**未处理的 Promise 拒绝**，在部分浏览器会冒到控制台甚至拖垮 SW 实例。补 `.catch(()=>{})`。 */
        .then(res => { if (res && res.ok) cache.put(req, res.clone()).catch(() => {}); return res; })
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
        cache.put(req, res.clone()).catch(() => {});   // T9：同上，写缓存失败不该炸出未处理拒绝
      }
      return res;
    } catch {
      /* T8（2026-10-04 审计）：断网兜底**不能**把 `./index.html` 当任意同源 GET 的替身 ——
         JS / CSS / PNG 请求若拿到一份 HTML（Content-Type: text/html）⇒ 浏览器按 MIME 拒执行 ⇒ 白屏。
         只有**导航请求**（地址栏进入 / 刷新）才回退 HTML；其余资源无缓存就直接 504，
         让调用方如实看到「离线且没缓存」，而不是把一个 HTML 塞给它。 */
      const hit = await caches.match(req);
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match('./index.html')) || Response.error();
      return new Response('', { status: 504, statusText: 'Offline' });
    }
  })());
});
