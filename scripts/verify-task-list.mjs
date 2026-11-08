#!/usr/bin/env node
/**
 * 校验 docs/学生任务清单.md 与 backend 源码中的 TODO(S2)/TODO(S3) 标记是否一致。
 *
 * 用法（在仓库根目录）：
 *   node scripts/verify-task-list.mjs          # 校验，失败时退出码 1
 *   node scripts/verify-task-list.mjs --detail # 额外打印逐文件对照表
 *
 * 校验的四件事：
 *   1. 文档列出的文件数、方法数与源码 TODO 方法数一致（每个方法在源码中有 2 处标记：javadoc + 异常消息）；
 *   2. 文档把每个方法归入的 Sprint 与源码标记的 S2/S3 一致；
 *   3. 文档列出的方法在源码中确实存在 TODO，源码中的 TODO 方法也都出现在文档里；
 *   4. TODO 消息里写的类名与所在文件一致（防止复制粘贴留错名）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DOC = path.join(ROOT, 'docs', '学生任务清单.md');
const DETAIL = process.argv.includes('--detail');

if (!fs.existsSync(DOC)) {
  console.error(`找不到 ${DOC}`);
  process.exit(1);
}

// ---------- 1. 解析文档 ----------
const docEntries = [];
let sprint = null;
let cur = null;
for (const raw of fs.readFileSync(DOC, 'utf8').split(/\r?\n/)) {
  const line = raw.trimEnd();
  const h = line.match(/^##\s+(S\d)\s*·/);
  if (h) { sprint = h[1]; cur = null; continue; }
  const f = line.match(/^- \*\*(.+?)\*\*（(.+?)）`(.+?)`\s*$/);
  if (f) {
    cur = { sprint, file: f[1], layer: f[2], rel: f[3].replaceAll('\\', '/'), methods: [] };
    docEntries.push(cur);
    continue;
  }
  const m = line.match(/^\s+- (.+)$/);
  if (m && cur) {
    for (const n of m[1].split('、')) {
      const v = n.trim().replace(/\(\)$/, '');
      if (v) cur.methods.push(v);
    }
  }
}

const docByFile = new Map(docEntries.map(e => [e.rel, e]));
const docMethodTotal = docEntries.reduce((a, e) => a + e.methods.length, 0);
const docBySprint = docEntries.reduce((a, e) => { a[e.sprint] = (a[e.sprint] || 0) + e.methods.length; return a; }, {});

// ---------- 2. 扫描源码 ----------
const javaFiles = [];
(function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.java')) javaFiles.push(p);
  }
})(path.join(ROOT, 'backend'));

const codeMarkers = new Map();   // rel -> 标记次数
const codeMethods = new Map();   // "rel#method" -> Set(sprint)
const classMismatch = [];

for (const abs of javaFiles) {
  const rel = path.relative(ROOT, abs).replaceAll('\\', '/');
  const src = fs.readFileSync(abs, 'utf8');
  const markers = (src.match(/TODO\(S[23]\)/g) || []).length;
  if (!markers) continue;
  codeMarkers.set(rel, markers);

  const re = /TODO\((S[23])\)\s*[：:]\s*(?:实现\s*)?([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const [, tag, cls, method] = m;
    const key = `${rel}#${method}`;
    if (!codeMethods.has(key)) codeMethods.set(key, new Set());
    codeMethods.get(key).add(tag);
    const fileBase = path.basename(abs, '.java');
    if (cls !== fileBase && !classMismatch.includes(`${rel}#${method}`)) classMismatch.push(`${rel}#${method}`);
  }
}

const codeMethodTotal = codeMarkers.size ? [...codeMarkers.values()].reduce((a, n) => a + n / 2, 0) : 0;

// ---------- 3. 比对 ----------
const problems = [];

for (const e of docEntries) {
  if (!fs.existsSync(path.join(ROOT, e.rel))) { problems.push(`文档文件不存在：${e.rel}`); continue; }
  const markers = codeMarkers.get(e.rel) || 0;
  if (markers / 2 !== e.methods.length) {
    problems.push(`${path.basename(e.rel)}：文档 ${e.methods.length} 个方法，源码标记 ${markers} 处（应为 ${e.methods.length * 2}）`);
  }
  for (const name of e.methods) {
    const hit = codeMethods.get(`${e.rel}#${name}`);
    if (!hit) problems.push(`${path.basename(e.rel)} :: 文档列出 ${name}()，源码没有对应 TODO`);
    else if (!hit.has(e.sprint)) problems.push(`${path.basename(e.rel)} :: ${name}() 文档=${e.sprint}，源码=${[...hit].join('/')}`);
  }
}

for (const [rel, markers] of codeMarkers) {
  if (!docByFile.has(rel)) problems.push(`源码有 TODO 但文档未收录：${rel}（${markers} 处标记）`);
}

for (const key of classMismatch) problems.push(`TODO 消息里的类名与文件名不符：${key}`);

// ---------- 4. 输出 ----------
console.log('文档：%d 个文件，%d 个方法（S2=%d，S3=%d）'.replace('%d', docEntries.length)
  .replace('%d', docMethodTotal).replace('%d', docBySprint.S2 || 0).replace('%d', docBySprint.S3 || 0));
console.log('源码：%d 个文件带 TODO，%d 个方法（每个方法 2 处标记）'.replace('%d', codeMarkers.size)
  .replace('%d', codeMethodTotal));

if (DETAIL) {
  console.log('\n逐文件对照（文档 / 源码标记÷2）：');
  for (const e of docEntries) {
    const markers = codeMarkers.get(e.rel) || 0;
    const ok = markers / 2 === e.methods.length;
    console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${path.basename(e.rel)}  ${e.methods.length} / ${markers / 2}  [${e.sprint}]`);
  }
}

if (problems.length) {
  console.log(`\n❌ 发现 ${problems.length} 处不一致：`);
  for (const p of problems) console.log('  -', p);
  process.exit(1);
}

if (docMethodTotal !== codeMethodTotal) {
  console.log(`\n❌ 方法总数不一致：文档 ${docMethodTotal}，源码 ${codeMethodTotal}`);
  process.exit(1);
}

console.log('\n✅ 一致：文档与源码的 TODO 方法、S2/S3 分类完全对应');
