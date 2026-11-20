#!/usr/bin/env node
/**
 * @file tests/package.mjs
 * 打包为可上传/分发的 zip（排除开发与测试产物）。
 * 用法：node tests/package.mjs
 * 输出：dist/edge-resource-download-<version>.zip
 */
import { readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'dist');

/** 打进包里的内容（白名单，避免误带 dev 资产） */
const INCLUDE = [
  'manifest.json',
  'background.js',
  'lib/',
  'content/',
  'popup/',
  'options/',
  'offscreen/',
  'icons/',
  '_locales/',
  'README.md',
  'LICENSE'
];

/** 排除（开发/测试产物） */
const EXCLUDE = [
  /^popup\/dev-mock\.js$/,
  /^icons\/build_icons\.py$/,
  /^icons\/_verify\.py$/,
  /^icons\/_sweep\.py$/,
  /^icons\/preview\.png$/,
  /^icons\/_z\d+\.png$/,
  /^icons\/_z128\.png$/,
  /^tests\//,
  /^docs\//,
  /^dist\//,
  /\.map$/
];

/* ---------------- 极小 ZIP 写入器（deflate + 中央目录） ---------------- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(d = new Date()) {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0xf) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

async function collect(rel, out = []) {
  const abs = join(ROOT, rel);
  let st;
  try {
    st = await stat(abs);
  } catch {
    return out;
  }
  if (st.isDirectory()) {
    for (const e of await readdir(abs, { withFileTypes: true })) {
      await collect(join(rel, e.name), out);
    }
  } else {
    // ⚠️ 统一为正斜杠：Windows 上 join() 产出反斜杠，会让下面按 `/` 写的
    //    排除正则全部失效（曾导致 dev-mock.js / *.py 被打进发布包）。
    const norm = rel.split(/[\\/]/).join('/');
    if (EXCLUDE.some((re) => re.test(norm))) return out;
    // 同时排除明显的开发脚本
    if (/\.(py|mjs|map)$/.test(norm)) return out;
    out.push(norm);
  }
  return out;
}

async function main() {
  const manifest = JSON.parse(await readFile(join(ROOT, 'manifest.json'), 'utf8'));
  const files = [];
  for (const inc of INCLUDE) await collect(inc.replace(/\/$/, ''), files);
  const unique = [...new Set(files)].sort();

  if (!unique.includes('manifest.json')) throw new Error('打包缺少 manifest.json');

  await mkdir(OUT_DIR, { recursive: true });
  const outFile = join(OUT_DIR, `edge-resource-download-${manifest.version}.zip`);

  const { time, date } = dosDateTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const rel of unique) {
    const raw = await readFile(join(ROOT, rel));
    const deflated = deflateRawSync(raw, { level: 9 });
    const useDeflate = deflated.length < raw.length;
    const data = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const nameBuf = Buffer.from(rel.replace(/\\/g, '/'), 'utf8');
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // utf-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);

    locals.push(local, nameBuf, data);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(unique.length, 8);
  eocd.writeUInt16LE(unique.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  await writeFile(outFile, Buffer.concat([...locals, centralBuf, eocd]));

  const size = (await stat(outFile)).size;
  console.log(`\n\x1b[32m打包完成\x1b[0m  ${relative(ROOT, outFile)}`);
  console.log(`  文件数 ${unique.length}  体积 ${(size / 1024).toFixed(1)} KB\n`);
  const omitted = ['tests/', 'docs/', 'popup/dev-mock.js', 'icons/*.py', 'icons/preview.png'];
  console.log(`  已排除：${omitted.join(', ')}`);
}

main().catch((e) => {
  console.error('打包失败:', e.message);
  process.exit(1);
});
