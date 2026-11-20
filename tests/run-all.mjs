#!/usr/bin/env node
/**
 * @file tests/run-all.mjs
 * 一键跑全部校验：结构巡检 → 扫描器专项 → 端到端 → 打包。
 * 用法：node tests/run-all.mjs [--skip-e2e] [--browser=chrome]
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const skipE2E = args.includes('--skip-e2e');
const passthrough = args.filter((a) => a !== '--skip-e2e');

const steps = [
  ['结构巡检', 'tests/check-structure.mjs'],
  ...(skipE2E
    ? []
    : [
        ['扫描器专项', 'tests/e2e-scan.mjs'],
        ['端到端下载', 'tests/e2e.mjs']
      ]),
  ['打包', 'tests/package.mjs']
];

const run = (script, extra = []) =>
  new Promise((res) => {
    const p = spawn(process.execPath, [script, ...extra], {
      cwd: ROOT,
      stdio: 'inherit',
      shell: false
    });
    p.on('exit', (code) => res(code ?? 1));
  });

const started = Date.now();
const failed = [];

for (const [label, script] of steps) {
  console.log(`\n\x1b[1m\x1b[36m▶ ${label}  (${script})\x1b[0m`);
  const code = await run(script, passthrough);
  if (code !== 0) failed.push(label);
}

const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n' + '='.repeat(52));
if (failed.length) {
  console.log(`\x1b[31m失败：${failed.join('、')}（耗时 ${secs}s）\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32m全部 ${steps.length} 项通过（耗时 ${secs}s）✔\x1b[0m`);
