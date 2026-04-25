#!/usr/bin/env bun
import path from 'node:path';
import { migrateStudyCacheFile } from '../src/study/cache.js';

const [fileArg] = process.argv.slice(2);
if (!fileArg) {
  console.error('usage: bun tools/bench/scripts/migrate-study-cache.ts <cache-file>');
  process.exit(2);
}

const file = path.resolve(fileArg);
const result = await migrateStudyCacheFile(file);
const saved = result.bytesBefore - result.bytesAfter;
const percent = result.bytesBefore > 0 ? (saved / result.bytesBefore) * 100 : 0;
console.log(
  JSON.stringify(
    {
      file,
      entries: result.entries,
      bytesBefore: result.bytesBefore,
      bytesAfter: result.bytesAfter,
      savedBytes: saved,
      savedPercent: Number(percent.toFixed(2)),
    },
    null,
    2,
  ),
);
