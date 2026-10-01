import { defineConfig } from 'vite';

/**
 * 构建配置
 * ===============================================================
 * 1. `base: './'` —— 产物用相对路径，传到任意子目录（或本地双击打开）都不会白屏。
 * 2. 文件名**带内容哈希**（2026-10-01 改）—— 原来是不带哈希的 `assets/[name].js`，图的是「覆盖上传方便」，
 *    但代价是：同名文件最容易被浏览器与 CDN 判成「没变」直接给旧的 —— 这正是「上传后手机拿不到新版」的头号原因。
 *    现在每次构建 `index.js` / `index.css` 都换一个新名字，`index.html` 只要刷新一次，新版就一定跟着来。
 *    （旧文件会留在服务器上，不碍事；要清就整个 `assets/` 覆盖。）
 * 3. `assetsInlineLimit: 0` —— 行情数据包（public/data/*.bin）本来就不走打包，
 *    这里只是保证 JS/CSS 不被内联成 base64。
 *
 * ⚠️ `target: 'es2020'`（S2 时从 es2019 升上来）：S0 的 `rng.js` 用 **BigInt 字面量**（`0n` 那种）
 *    做 splitmix64，而 BigInt 字面量是 ES2020 才有的语法 —— es2019 下 esbuild 直接报错。
 *    这个目标与项目本来的口径一致：`market.js` 依赖 `DecompressionStream`（2023 起才铺开）、
 *    `Blob.stream()` 等，本来就不是给老浏览器准备的。
 */
/**
 * 构建时间戳（用户 2026-10-01 拍板）—— 编译期把「这一刻」写进产物，主菜单底部读出来，
 * 一眼分辨「服务器上跑的是哪一版」。
 *
 * ⚠️ 必须是 `define` 而不是运行时的 `new Date()`：运行时取到的是**玩家打开页面的时刻**，
 *    那是这个读数最没有意义的东西（每次刷新都变）。
 * ⚠️ 手写 +8 小时再切 ISO，而不是 `toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })`：
 *    后者跟 Node 的 ICU 数据与运行环境走，同一份代码在 CI 与本机会印出不同的串。
 */
const BUILD_DATE = (() => {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC+8`;
})();

/**
 * 构建指纹（2026-10-01）—— **给缓存用的**，与 `BUILD_DATE` 是两件事。
 *
 * `main.js` 拿它拼 Service Worker 的脚本 URL：`sw.js?v=<BUILD_ID>`。
 * 浏览器只在「脚本内容变了」时才更新 SW，而多数发版我们**根本没改 `sw.js`** ——
 * 换个 query 就足以让它当成新脚本，立刻装载、立刻清掉旧缓存（见 `public/sw.js` 顶部注释）。
 *
 * ⚠️ 不能用 `BUILD_DATE` 顶替：它精确到**分钟**、还带空格与冒号；同一分钟内连发两版会撞成同一个值。
 *    这里用毫秒时间戳的 36 进制（短且天然递增）。
 */
const BUILD_ID = Date.now().toString(36);

export default defineConfig({
  base: './',

  define: {
    /* `render.js` 的主菜单底部那行「构建 …」读它。dev 与 build 都生效（esbuild 的 define）。 */
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
    /* `main.js` 的 SW 注册读它，见上。 */
    __BUILD_ID__: JSON.stringify(BUILD_ID),
  },

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2020',
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].[hash].js',
        chunkFileNames: 'assets/[name].[hash].js',
        assetFileNames: 'assets/[name].[hash].[ext]',
      },
    },
  },

  server: {
    port: 5174,
    host: true,        // 允许手机通过局域网访问，便于真机测竖屏
    strictPort: false,
  },

  preview: {
    port: 4174,
    host: true,
  },
});
