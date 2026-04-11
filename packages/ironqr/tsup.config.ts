import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    qr: 'src/qr/index.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  target: 'es2022',
  outDir: 'dist',
  external: ['effect'],
});
