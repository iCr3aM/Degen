import { defineConfig } from 'vite';

/**
 * 构建配置
 * ===============================================================
 * 1. `base: './'` —— 产物用相对路径，传到任意子目录（或本地双击打开）都不会白屏。
 * 2. 文件名不带哈希 —— 覆盖上传方便，缓存由 `?v=` 那套另说（P4 再加）。
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

export default defineConfig({
  base: './',

  define: {
    /* `render.js` 的主菜单底部那行「构建 …」读它。dev 与 build 都生效（esbuild 的 define）。 */
    __BUILD_DATE__: JSON.stringify(BUILD_DATE),
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
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
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
