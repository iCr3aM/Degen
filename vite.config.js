import { defineConfig } from 'vite';

/**
 * 构建配置
 * ===============================================================
 * 1. `base: './'` —— 产物用相对路径，传到任意子目录（或本地双击打开）都不会白屏。
 * 2. 文件名不带哈希 —— 覆盖上传方便，缓存由 `?v=` 那套另说（P4 再加）。
 * 3. `assetsInlineLimit: 0` —— 行情数据包（public/data/*.bin）本来就不走打包，
 *    这里只是保证 JS/CSS 不被内联成 base64。
 */
export default defineConfig({
  base: './',

  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2019',
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
