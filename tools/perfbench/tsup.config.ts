import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  minify: false,
  splitting: false,
  target: 'es2022',
  outDir: 'dist',
  external: ['ironqr-corpus-cli', 'ironqr'],
});
