import { build } from 'esbuild';
await build({
  entryPoints: ['client/index.tsx'], bundle: true, format: 'cjs', platform: 'browser', target: 'es2022',
  outfile: 'dist/client.js', external: ['react'], jsx: 'transform', sourcemap: true,
  banner: { js: 'window.__ModuleLoader__.load({ id: "dsh-shiguang", factory: (require) => { var module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
});
