/**
 * @xinghe-source/dsh-report-studio — 让报告从「一次性文档」变成「活的视图」。
 *
 * 问题：渗透 / SRC / WP / 实验报告几乎都是一次性产物。可真实需求是「同一个目标
 * 今天跑一次、明天再跑一次，我要的是两个时点的差异」。静态 Markdown 表达不了
 * 「和上次比新增了什么」——两份互不相干的文档里，这个信息根本不存在。
 *
 * 这个插件把报告变成一个**有名字、可追加**的容器：
 *   - `report_save`   把一次运行的结果存成某报告的新快照（结构化条目 + 可选正文）
 *   - `report_diff`   把两个快照做结构化比对，输出「新增 / 消失 / 变化」
 *   - `report_list`   有哪些报告、各有多少快照、最近一次什么时候
 *   - `report_render` 把某个快照渲染成完整 Markdown（含本次变更章节）
 *
 * 三个设计要点：
 *   1. **条目要有稳定标识**。diff 按标识配对，不按数组下标。标识优先取用户给的
 *      `key`（其次 id/title/name），没有就退化成内容哈希——这时候内容一变就会被
 *      同时算作「新增」和「消失」，属于诚实的限制，输出里会明确警告。
 *   2. **写入是原子的**。先写同目录临时文件、fsync、再 rename，避免半写坏数据；
 *      索引（report.json）与快照文件分离，索引损坏或落后都能从目录自愈。
 *   3. **状态只写 `~/.dsh/report-studio/`**，绝不写工作区——工作区常在 OneDrive
 *      里，每次快照都会触发云盘同步 churn。需要读写用户指定路径的 Markdown 时，
 *      才通过 DSH 的 `fs` 服务（可选依赖）显式操作。
 *
 * 必须以命名导出暴露 apply/inject：Loader 的 unwrapExports 会折叠 `export default`
 * 并静默丢掉 inject，导致插件无声失效。
 * @module @xinghe-source/dsh-report-studio
 */
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** Plugin name shown in the loader tree. */
const name = 'report-studio';

/**
 * Hard dependency: the tool registry this plugin contributes to.
 *
 * `fs` is deliberately NOT here. Declaring it would make the whole plugin stay in
 * PENDING (and vanish without an error) on any deployment that mounts no filesystem
 * backend, even though every core capability of this plugin only touches
 * `~/.dsh/report-studio/` through plain node:fs. The filesystem seam is picked up
 * separately with an optional scoped inject, so it powers only the two features
 * that genuinely need it: reading a Markdown body from a user path and writing a
 * rendered report to a user path.
 */
const inject = ['tools'];

/** Default state root. Never the workspace: it usually lives on a synced drive. */
const DEFAULT_DIR = join(homedir(), '.dsh', 'report-studio');

/** Format tag written into every snapshot file, so a future version can migrate. */
const SNAPSHOT_FORMAT = 'dsh-report-studio/snapshot@1';

/** Format tag written into every report index. */
const REPORT_FORMAT = 'dsh-report-studio/report@1';

/** Deployment configuration, editable from the Settings UI. */
const Config = z.object({
  dir: z
    .string()
    .default(DEFAULT_DIR)
    .description('状态根目录。默认 ~/.dsh/report-studio；改成工作区会让每次快照都触发云盘同步。'),
  identityFields: z
    .array(z.string())
    .default(['key', 'id', 'title', 'name'])
    .description('按顺序尝试作为条目稳定标识的字段名；都取不到时退化为内容哈希。'),
  diffLimit: z
    .number()
    .default(50)
    .description('diff / 保存回执里每个分区最多返回的条目数，防止报告过大撑爆上下文。'),
  maxSnapshots: z
    .number()
    .default(0)
    .description('单个报告最多保留的快照数，0 表示不限制。超出时剪掉最旧的（只删快照文件）。'),
  maxBodyChars: z
    .number()
    .default(200_000)
    .description('单个快照正文的最大字符数；超出部分截断并在结果里标记 bodyTruncated。'),
  maxRenderChars: z
    .number()
    .default(60_000)
    .description('report_render 直接返回给模型的 Markdown 最大字符数；写文件时始终写完整正文。'),
});

// ---------------------------------------------------------------------------
// 纯函数：标识、序列化、时间
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON: object keys sorted, so two structurally equal values hash
 * the same. This is what makes content-hash identities and change detection stable.
 * @param value - any lossless JSON value.
 * @returns the canonical string form.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

/**
 * Short content hash used as the identity of an entry that declares no stable field.
 * @param value - the entry.
 * @returns 16 hex characters.
 */
function hashOf(value) {
  return createHash('sha1').update(canonicalJson(value)).digest('hex').slice(0, 16);
}

/**
 * Normalize a string identity so trivial whitespace edits do not create a false diff.
 * Case is deliberately preserved: `Report.pdf` and `report.pdf` are different targets.
 * @param text - raw identity text.
 * @returns collapsed, trimmed text.
 */
function normalizeIdentity(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Derive the stable identity of one entry.
 * @param item - the entry, usually an object.
 * @param fields - candidate identity field names, in priority order.
 * @returns the identity key plus whether it came from a declared field.
 */
function identityOf(item, fields) {
  if (item !== null && typeof item === 'object' && !Array.isArray(item)) {
    for (const field of fields) {
      const raw = item[field];
      if (typeof raw === 'string' && raw.trim() !== '') {
        return { key: `${field}:${normalizeIdentity(raw)}`, field, stable: true };
      }
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return { key: `${field}:#${raw}`, field, stable: true };
      }
    }
  }
  return { key: `hash:${hashOf(item)}`, stable: false };
}

/**
 * One-line, bounded rendering of an arbitrary JSON value, for tables and diffs.
 * @param value - any value.
 * @param max - maximum characters.
 * @returns the preview string, single line.
 */
function previewOf(value, max = 160) {
  if (value === undefined) return '';
  const text = typeof value === 'string' ? value : canonicalJson(value);
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/**
 * Human-readable label for one entry: the first plausible title-ish field.
 * @param item - the entry.
 * @returns the label, or undefined when nothing usable is present.
 */
function titleOf(item) {
  if (typeof item === 'string' && item.trim() !== '') return previewOf(item, 80);
  if (item === null || typeof item !== 'object' || Array.isArray(item)) return undefined;
  for (const field of ['title', 'name', 'key', 'id', 'target', 'detail']) {
    const raw = item[field];
    if (typeof raw === 'string' && raw.trim() !== '') return previewOf(raw, 80);
  }
  return undefined;
}

/** Local wall-clock rendering of an epoch-millisecond instant. */
function localTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

/** File-name-safe compact UTC stamp: `20261005T212147123Z`. */
function stampOf(ms) {
  return new Date(ms).toISOString().replace(/[-:.]/g, '');
}

/** The snapshot file name for one instant and id. Colons are illegal on Windows. */
function fileNameOf(ms, id) {
  return `${stampOf(ms)}--${id}.json`;
}

/** Matches `20261005T212147123Z--a1b2c3.json`. */
const SNAPSHOT_FILE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z--([0-9a-z]+)\.json$/;

/**
 * Parse a snapshot file name back into its identity and instant. Listing the
 * directory is the source of truth, so the instant must be recoverable without
 * reading the file — that is why it is encoded in the name.
 * @param fileName - the directory entry.
 * @returns `{ id, atMs }`, or undefined for anything unrecognized.
 */
function parseSnapshotFileName(fileName) {
  const match = SNAPSHOT_FILE.exec(fileName);
  if (match === null) return undefined;
  const atMs = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
    Number(match[7]),
  );
  if (!Number.isFinite(atMs)) return undefined;
  return { id: match[8], atMs };
}

/**
 * Turn a report name into a directory-safe slug.
 *
 * CJK is kept (报告名多半是中文，换成拼音或哈希就没法认了)；Windows 非法字符、
 * 路径分隔符与保留设备名被处理掉，所以 slug 永远不可能逃出 reports/ 目录。
 * @param reportName - the user-visible report name.
 * @returns the slug, or undefined when nothing usable is left.
 */
function slugify(reportName) {
  const base = String(reportName)
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex -- control characters are illegal in file names
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[.\-\s]+|[.\-\s]+$/g, '');
  if (base === '' || base === '.' || base === '..') return undefined;
  const safe = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base) ? `_${base}` : base;
  return safe.slice(0, 64);
}

// ---------------------------------------------------------------------------
// 存储：原子写、索引自愈
// ---------------------------------------------------------------------------

/** Transient Windows rename failures caused by AV/indexer holding the destination. */
const TRANSIENT_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** @param ms - milliseconds to wait. @returns a promise resolving after `ms`. */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Write a file atomically: same-directory temp file → fsync → rename.
 *
 * A half-written snapshot is worse than no snapshot: it would poison every later
 * diff. `rename` inside one directory is the atomic step; the fsync before it makes
 * sure the bytes are on disk first, not just in the page cache.
 * @param path - destination path.
 * @param text - full file content.
 * @returns the byte length written.
 */
async function writeFileAtomic(path, text) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temp = join(directory, `.tmp-${process.pid}-${randomBytes(4).toString('hex')}`);
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await rename(temp, path);
        return Buffer.byteLength(text, 'utf8');
      } catch (error) {
        lastError = error;
        if (!TRANSIENT_RENAME.has(error?.code)) throw error;
        await delay(20 * (attempt + 1));
      }
    }
    throw lastError;
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => {});
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

/**
 * Read and parse JSON, treating every failure as absence. Reads must never throw:
 * a corrupt index has to degrade into "rebuild from the directory", not into a
 * broken tool.
 * @param path - file to read.
 * @returns the parsed value, or undefined.
 */
async function readJsonIfPresent(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Serialize per-report mutations so an index rewrite never interleaves. */
const reportLocks = new Map();

/**
 * Run `operation` with exclusive access to one report's directory.
 * @param key - lock key (the report slug).
 * @param operation - async work.
 * @returns the operation's result.
 */
function withReportLock(key, operation) {
  const previous = reportLocks.get(key) ?? Promise.resolve();
  const next = previous.then(operation, operation);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  reportLocks.set(key, settled);
  void settled.then(() => {
    if (reportLocks.get(key) === settled) reportLocks.delete(key);
  });
  return next;
}

/**
 * Load one report's snapshot list.
 *
 * The directory listing is authoritative and the index is only metadata. That
 * ordering is what makes a crash between "snapshot written" and "index updated"
 * harmless: the orphan file is still discovered, only its cached item count is
 * missing until the next save rewrites the index.
 * @param root - the state root.
 * @param slug - the report slug.
 * @returns the report view.
 */
async function loadReport(root, slug) {
  const dir = join(root, 'reports', slug);
  const manifest = await readJsonIfPresent(join(dir, 'report.json'));

  let entries = [];
  try {
    entries = await readdir(join(dir, 'snapshots'));
  } catch {
    entries = [];
  }

  const byId = new Map();
  for (const entry of entries) {
    const parsed = parseSnapshotFileName(entry);
    if (parsed === undefined) continue;
    byId.set(parsed.id, { id: parsed.id, atMs: parsed.atMs, file: entry });
  }

  const indexed = Array.isArray(manifest?.snapshots) ? manifest.snapshots : [];
  for (const meta of indexed) {
    if (meta === null || typeof meta !== 'object') continue;
    const hit = byId.get(typeof meta.id === 'string' ? meta.id : '');
    if (hit === undefined) continue; // index entry without a file: stale, dropped
    if (Number.isInteger(meta.items) && meta.items >= 0) hit.items = meta.items;
    if (typeof meta.label === 'string' && meta.label !== '') hit.label = meta.label;
    if (typeof meta.source === 'string' && meta.source !== '') hit.source = meta.source;
    if (typeof meta.at === 'string' && meta.at !== '') hit.at = meta.at;
    if (meta.hasBody === true) hit.hasBody = true;
  }

  const snapshots = [...byId.values()].sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  for (const [index, snapshot] of snapshots.entries()) {
    snapshot.index = index + 1;
    if (typeof snapshot.at !== 'string') snapshot.at = new Date(snapshot.atMs).toISOString();
  }

  return {
    dir,
    slug,
    name: typeof manifest?.name === 'string' && manifest.name !== '' ? manifest.name : slug,
    createdAt: typeof manifest?.createdAt === 'string' ? manifest.createdAt : undefined,
    manifest,
    snapshots,
    exists: snapshots.length > 0 || manifest !== undefined,
  };
}

/**
 * Read one snapshot file.
 * @param report - the loaded report view.
 * @param snapshot - one entry from `report.snapshots`.
 * @returns the parsed snapshot, or undefined when it is unreadable.
 */
async function readSnapshot(report, snapshot) {
  const parsed = await readJsonIfPresent(join(report.dir, 'snapshots', snapshot.file));
  if (parsed === null || typeof parsed !== 'object') return undefined;
  return parsed;
}

/**
 * Build the index document for a report view.
 * @param report - the loaded report view.
 * @param atIso - the update instant.
 * @returns a plain JSON index document.
 */
function buildManifest(report, atIso) {
  // Canonical order on disk: the same (instant, id) order every load derives from the
  // directory. Without this, concurrent saves would persist creation order in the index
  // while the next load sorts by instant — two different orders for one truth.
  const ordered = [...report.snapshots].sort((a, b) => a.atMs - b.atMs || (a.id < b.id ? -1 : 1));
  return {
    format: REPORT_FORMAT,
    name: report.name,
    slug: report.slug,
    createdAt: report.createdAt ?? atIso,
    updatedAt: atIso,
    snapshots: ordered.map((snapshot) => ({
      id: snapshot.id,
      at: snapshot.at,
      atMs: snapshot.atMs,
      file: snapshot.file,
      items: Number.isInteger(snapshot.items) ? snapshot.items : 0,
      ...(typeof snapshot.label === 'string' ? { label: snapshot.label } : {}),
      ...(typeof snapshot.source === 'string' ? { source: snapshot.source } : {}),
      ...(snapshot.hasBody === true ? { hasBody: true } : {}),
    })),
  };
}

/**
 * Fill in the metadata the index did not carry.
 *
 * A snapshot file whose index entry is missing (the process died between the two
 * atomic writes, or the index was hand-edited) still has to list correctly: the
 * directory gives existence and the instant, the file gives the rest.
 * @param report - the loaded report view.
 * @param snapshot - one entry from `report.snapshots`, mutated in place.
 * @returns the snapshot, hydrated.
 */
async function hydrateSnapshot(report, snapshot) {
  if (snapshot.items !== undefined && snapshot.label !== undefined) return snapshot;
  const document = await readSnapshot(report, snapshot);
  if (snapshot.items === undefined) snapshot.items = Array.isArray(document?.items) ? document.items.length : 0;
  if (snapshot.hasBody === undefined) snapshot.hasBody = typeof document?.body === 'string' && document.body !== '';
  if (typeof document?.label === 'string' && document.label !== '') snapshot.label = document.label;
  if (typeof document?.source === 'string' && document.source !== '') snapshot.source = document.source;
  return snapshot;
}

// ---------------------------------------------------------------------------
// diff：结构化比对
// ---------------------------------------------------------------------------

/**
 * Group entries by identity, keeping first-seen order for stable display.
 * @param items - the entry list.
 * @param fields - identity field candidates.
 * @returns the map plus how many entries fell back to a content hash.
 */
function indexItems(items, fields) {
  const index = new Map();
  let hashed = 0;
  for (const item of items) {
    const identity = identityOf(item, fields);
    if (!identity.stable) hashed += 1;
    if (!index.has(identity.key)) index.set(identity.key, { identity, item });
  }
  return { index, hashed };
}

/**
 * Field-level difference between two versions of the same entry.
 * @param before - previous entry.
 * @param after - current entry.
 * @returns one record per top-level field, sorted by field name.
 */
function fieldChanges(before, after) {
  const left = before !== null && typeof before === 'object' && !Array.isArray(before) ? before : {};
  const right = after !== null && typeof after === 'object' && !Array.isArray(after) ? after : {};
  const names = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changes = [];
  for (const field of [...names].sort()) {
    const from = left[field];
    const to = right[field];
    if (canonicalJson(from) === canonicalJson(to)) continue;
    changes.push({ field, from: previewOf(from, 120), to: previewOf(to, 120) });
  }
  return changes;
}

/**
 * Compare two snapshots structurally.
 *
 * Matching is by stable identity, never by position: reordering a scan's output
 * must not produce a diff. Sections keep the input order of the snapshot they come
 * from, so a report's intentional severity ordering survives.
 * @param baseItems - the baseline entries.
 * @param headItems - the current entries.
 * @param fields - identity field candidates.
 * @param limit - maximum records per section.
 * @returns the four partitions plus truncation facts.
 */
function buildDiff(baseItems, headItems, fields, limit) {
  const base = indexItems(baseItems, fields);
  const head = indexItems(headItems, fields);

  const added = [];
  const changed = [];
  for (const [key, entry] of head.index) {
    const previous = base.index.get(key);
    if (previous === undefined) {
      added.push({ key, identity: entry.identity.key, stable: entry.identity.stable, item: entry.item });
      continue;
    }
    if (canonicalJson(previous.item) === canonicalJson(entry.item)) continue;
    const fieldsChanged = fieldChanges(previous.item, entry.item);
    // Identical canonical JSON with a non-empty field list is impossible, but a
    // non-object pair yields an empty list; keep the record either way.
    changed.push({
      key,
      identity: entry.identity.key,
      stable: entry.identity.stable,
      before: previous.item,
      after: entry.item,
      fields: fieldsChanged,
    });
  }

  const removed = [];
  for (const [key, entry] of base.index) {
    if (head.index.has(key)) continue;
    removed.push({ key, identity: entry.identity.key, stable: entry.identity.stable, item: entry.item });
  }

  const cap = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 50;
  return {
    counts: {
      added: added.length,
      removed: removed.length,
      changed: changed.length,
      unchanged: head.index.size - added.length - changed.length,
      baseTotal: base.index.size,
      headTotal: head.index.size,
    },
    added: added.slice(0, cap),
    removed: removed.slice(0, cap),
    changed: changed.slice(0, cap),
    truncated: added.length > cap || removed.length > cap || changed.length > cap,
    hashedBase: base.hashed,
    hashedHead: head.hashed,
    limit: cap,
  };
}

/**
 * Resolve a snapshot reference against an ordered snapshot list.
 *
 * Accepted forms: `latest`/`last`, `previous`/`prev`, `#N` or `N` (1-based, negative
 * counts from the end), a full id, a unique id prefix, or the compact timestamp
 * prefix of a file name. Ambiguity is reported rather than guessed.
 * @param snapshots - ordered snapshots, oldest first.
 * @param ref - the reference text.
 * @param asOf - index of the reference point for `previous`.
 * @returns `{ snapshot }`, `{ none: true }`, or `{ error }`.
 */
function resolveRef(snapshots, ref, asOf) {
  const text = String(ref).trim();
  const lower = text.toLowerCase();
  if (lower === 'previous' || lower === 'prev' || lower === 'last-1') {
    const position = (asOf ?? snapshots.length) - 1;
    return position >= 0 && position < snapshots.length ? { snapshot: snapshots[position] } : { none: true };
  }
  if (lower === 'latest' || lower === 'last' || lower === 'head') {
    return snapshots.length > 0 ? { snapshot: snapshots[snapshots.length - 1] } : { none: true };
  }

  const numbered = /^#?(-?\d+)$/.exec(text);
  if (numbered !== null) {
    const raw = Number(numbered[1]);
    const position = raw > 0 ? raw - 1 : snapshots.length + raw;
    if (position < 0 || position >= snapshots.length) {
      return { error: `快照序号 ${text} 超出范围` };
    }
    return { snapshot: snapshots[position] };
  }

  const matches = snapshots.filter(
    (snapshot) => snapshot.id === text || snapshot.id.startsWith(lower) || snapshot.file.startsWith(lower),
  );
  if (matches.length === 1) return { snapshot: matches[0] };
  if (matches.length === 0) return { error: `找不到快照「${text}」` };
  return { error: `快照引用「${text}」不唯一（匹配到 ${matches.length} 个）` };
}

// ---------------------------------------------------------------------------
// Markdown 渲染
// ---------------------------------------------------------------------------

/** Escape a cell value for a Markdown table. */
function cell(value) {
  const text = value === undefined || value === null ? '' : String(value);
  return text.replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
}

/**
 * Render a full report document: header, change section, entry table, body.
 * @param input - the report view plus the diff to embed.
 * @returns the Markdown document.
 */
function renderMarkdown(input) {
  const { report, snapshot, diff, from } = input;
  const lines = [];
  lines.push(`# ${report.name}`, '');

  const meta = [`快照 \`${snapshot.id}\``, `#${snapshot.index}`, localTime(snapshot.atMs), `\`${snapshot.at}\``];
  if (typeof snapshot.label === 'string') meta.push(`标签：${snapshot.label}`);
  if (typeof snapshot.source === 'string') meta.push(`来源：${snapshot.source}`);
  lines.push(`> ${meta.join(' · ')}`);
  lines.push('>');
  lines.push(`> 报告目录：\`${report.dir}\``);
  lines.push('');

  const counts = diff.counts;
  lines.push('## 本次变更', '');
  if (from === undefined) {
    lines.push('这是该报告的第一个快照，没有基线可比对——下列条目全部计为新增。', '');
  } else {
    lines.push(`基线：快照 \`${from.id}\`（#${from.index} · ${localTime(from.atMs)}）`, '');
  }
  lines.push(
    `**新增 ${counts.added} · 消失 ${counts.removed} · 变化 ${counts.changed} · 未变 ${counts.unchanged}**（当前共 ${counts.headTotal} 条）`,
    '',
  );

  if (counts.added === 0 && counts.removed === 0 && counts.changed === 0) {
    lines.push('本次快照与基线完全一致：没有新增、没有消失、没有变化。', '');
  } else {
    if (diff.added.length > 0) {
      lines.push('### 新增', '');
      for (const entry of diff.added) {
        lines.push(`- **${cell(titleOf(entry.item) ?? entry.identity)}** — \`${entry.identity}\``);
      }
      if (counts.added > diff.added.length) lines.push(`- …另有 ${counts.added - diff.added.length} 条未列出`);
      lines.push('');
    }
    if (diff.removed.length > 0) {
      lines.push('### 消失', '');
      for (const entry of diff.removed) {
        lines.push(`- ~~${cell(titleOf(entry.item) ?? entry.identity)}~~ — \`${entry.identity}\``);
      }
      if (counts.removed > diff.removed.length) lines.push(`- …另有 ${counts.removed - diff.removed.length} 条未列出`);
      lines.push('');
    }
    if (diff.changed.length > 0) {
      lines.push('### 变化', '');
      for (const entry of diff.changed) {
        lines.push(`- **${cell(titleOf(entry.after) ?? entry.identity)}** — \`${entry.identity}\``);
        for (const change of entry.fields) {
          lines.push(`  - \`${change.field}\`: ${cell(change.from) || '(空)'} → ${cell(change.to) || '(空)'}`);
        }
      }
      if (counts.changed > diff.changed.length) lines.push(`- …另有 ${counts.changed - diff.changed.length} 条未列出`);
      lines.push('');
    }
  }

  const items = Array.isArray(snapshot.items) ? snapshot.items : [];
  lines.push(`## 全部条目（${items.length}）`, '');
  if (items.length === 0) {
    lines.push('本次快照没有结构化条目。', '');
  } else {
    lines.push('| # | 标识 | 标题 | 摘要 |', '| --- | --- | --- | --- |');
    for (const [index, item] of items.entries()) {
      const identity = identityOf(item, input.identityFields);
      lines.push(
        `| ${index + 1} | \`${cell(identity.key)}\` | ${cell(titleOf(item))} | ${cell(previewOf(item, 100))} |`,
      );
    }
    lines.push('');
  }

  if (typeof snapshot.body === 'string' && snapshot.body !== '') {
    lines.push('## 正文', '', snapshot.body, '');
  }

  lines.push('---', '', `由 \`@xinghe-source/dsh-report-studio\` 生成。`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 插件主体
// ---------------------------------------------------------------------------

/**
 * Register the four report tools and pick up the optional filesystem seam.
 * @param ctx - registrant context carrying `tools` (and `inject` for optional services).
 * @param config - resolved deployment configuration.
 */
function apply(ctx, config) {
  const root = typeof config.dir === 'string' && config.dir.trim() !== '' ? config.dir : DEFAULT_DIR;
  const identityFields =
    Array.isArray(config.identityFields) && config.identityFields.length > 0
      ? config.identityFields.filter((field) => typeof field === 'string' && field !== '')
      : ['key', 'id', 'title', 'name'];
  const diffLimit = Number.isFinite(config.diffLimit) && config.diffLimit > 0 ? Math.floor(config.diffLimit) : 50;
  const maxSnapshots = Number.isFinite(config.maxSnapshots) && config.maxSnapshots > 0 ? Math.floor(config.maxSnapshots) : 0;
  const maxBodyChars = Number.isFinite(config.maxBodyChars) && config.maxBodyChars > 0 ? Math.floor(config.maxBodyChars) : 200_000;
  const maxRenderChars =
    Number.isFinite(config.maxRenderChars) && config.maxRenderChars > 0 ? Math.floor(config.maxRenderChars) : 60_000;

  /**
   * The filesystem seam, when the deployment mounts a backend.
   *
   * Picked up through an optional scoped inject instead of `inject: ['fs']`: a
   * missing backend must cost the two user-path features, not the whole plugin.
   * @type {object|undefined}
   */
  let fs;
  if (typeof ctx.inject === 'function') {
    ctx.inject(['fs'], (scope) => {
      fs = scope.fs;
      // The backend can be unloaded (reload / HMR) while this plugin stays active.
      // Drop the reference then, instead of calling into a disposed service later.
      if (typeof scope.effect === 'function') {
        scope.effect(() => () => {
          fs = undefined;
        });
      }
    });
  }

  /** Session working directory, for resolving relative user paths. */
  const cwdOf = (exec) => exec?.agent?.session?.header?.cwd;

  /** Resolve a user-supplied path through the fs seam. */
  const resolveUserPath = async (path, exec) => {
    if (fs === undefined) {
      throw new Error(
        '这个部署没有挂载 fs 服务，无法读写用户指定路径。' +
          '报告快照本身不受影响（它写在 ~/.dsh/report-studio/），把正文直接放进 body 参数即可。',
      );
    }
    const cwd = cwdOf(exec);
    return cwd === undefined ? fs.resolve(path, { signal: exec?.signal }) : fs.resolve(path, { cwd, signal: exec?.signal });
  };

  /** Read a Markdown body from a user path through the fs seam. */
  const readUserText = async (path, exec) => {
    const target = await resolveUserPath(path, exec);
    return { text: await fs.readText(target, exec?.signal), displayPath: target.displayPath ?? String(path) };
  };

  /**
   * Write rendered Markdown to a user path through the fs seam.
   *
   * The write goes through the deployment's `fs/write-intent` waterfall on purpose:
   * bypassing it would make this plugin a hole in the read-before-write policy that
   * every other writing tool respects.
   */
  const writeUserText = async (path, text, exec) => {
    const target = await resolveUserPath(path, exec);
    const intent =
      typeof ctx.waterfall === 'function'
        ? await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
        : undefined;
    try {
      await fs.writeText(target, text, intent, exec?.signal);
    } catch (error) {
      if (error?.code === 'FS_NOT_OBSERVED') {
        throw new Error(
          `目标文件已存在但没有先读过，写入被文件观察策略拦下：${target.displayPath}` +
            '。改用一个新路径（例如带日期戳的文件名），或先用 read 读一次该文件再重试。',
        );
      }
      throw error;
    }
    return { path: target.displayPath ?? String(path), chars: text.length };
  };

  /**
   * Load a report by name, failing loudly when the name cannot be a directory.
   *
   * The user-visible name is fixed by the FIRST save; a later save that slugifies to
   * the same directory keeps it, so `report_list` never shows a name drifting under
   * the same identity.
   */
  const openReport = async (reportName) => {
    const slug = slugify(reportName);
    if (slug === undefined) {
      throw new Error(`报告名「${String(reportName)}」不能作为目录名：去掉路径分隔符与非法字符后再试。`);
    }
    const loaded = await loadReport(root, slug);
    return { ...loaded, name: loaded.manifest === undefined ? String(reportName) : loaded.name };
  };

  // ---- report_save -------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'report_save',
      description:
        'Append one timestamped snapshot to a NAMED report, then immediately diff it against the previous snapshot. ' +
        'Use this instead of writing a fresh standalone document whenever the same target is scanned, tested or solved more than once: the report keeps its identity and every run becomes a comparable data point. ' +
        'Entries are arbitrary JSON objects; give each one a stable "key" (or a stable "title") so later runs pair up correctly. ' +
        'Snapshots are stored atomically under ~/.dsh/report-studio/ — never in the workspace, which would cause cloud-sync churn. ' +
        '把这次的结果追加为某命名报告的新快照，并立刻给出与上一快照的差异。',
      parameters: {
        report: {
          type: 'string',
          required: true,
          description:
            '报告名，例如 "edusrc报告"、"校赛WP"、"东盟WP-第3题"、"物理实验-示波器"。同一个名字就是同一份报告，后续快照都追加到它下面。',
        },
        items: {
          type: 'array',
          description:
            `本次运行的结构化条目。每条建议带 key（稳定标识，例如 URL、CVE、题号）；没有 key 时按 ${identityFields.join(' → ')} 顺序取标识，全都取不到就用内容哈希（内容一变就会显示成「新增+消失」）。除下列字段外的任意字段都会被完整保留并参与 diff。`,
          items: {
            type: 'object',
            additionalProperties: true,
            properties: {
              key: { type: 'string', description: '稳定标识，优先用作 diff 配对依据。' },
              title: { type: 'string', description: '条目标题（漏洞名、题目名、实验项）。' },
              severity: { type: 'string', description: '严重度，例如 critical/high/medium/low/info。' },
              target: { type: 'string', description: '影响目标：URL、IP、端口、文件、题号。' },
              status: { type: 'string', description: '状态，例如 open/fixed/verified/wontfix。' },
              detail: { type: 'string', description: '细节描述、复现步骤、要点。' },
              tags: { type: 'array', items: { type: 'string' }, description: '标签，例如 ["sqli","waf-bypass"]。' },
            },
          },
        },
        body: {
          type: 'string',
          description: '可选 Markdown 正文（整篇报告的叙述部分）。与 items 一起存进同一个快照。',
        },
        bodyPath: {
          type: 'string',
          description:
            '可选：从该路径读取 Markdown 正文（需要部署挂载了 fs 服务）。比 body 更适合正文很长或由别的工具刚写完的场景。',
        },
        label: { type: 'string', description: '本次快照标签，例如 "第二次扫描"、"复测"、"决赛环境"。' },
        source: { type: 'string', description: '数据来源，例如 "nmap -sV"、"nuclei -t cves"、"手工复现"。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            report: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                name: { type: 'string', required: true },
                slug: { type: 'string', required: true },
                dir: { type: 'string', required: true },
              },
            },
            snapshot: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                id: { type: 'string', required: true },
                at: { type: 'string', required: true },
                atLocal: { type: 'string', required: true },
                index: { type: 'integer', required: true },
                items: { type: 'integer', required: true },
                keyed: { type: 'integer', required: true },
                hashed: { type: 'integer', required: true },
                bodyChars: { type: 'integer', required: true },
                bodyTruncated: { type: 'boolean', required: true },
                bodyFrom: { type: 'string' },
                label: { type: 'string' },
                source: { type: 'string' },
                file: { type: 'string', required: true },
              },
            },
            previous: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                at: { type: 'string', required: true },
                atLocal: { type: 'string', required: true },
                index: { type: 'integer', required: true },
                label: { type: 'string' },
              },
            },
            baseline: { type: 'string', required: true, enum: ['auto', 'none'] },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                added: { type: 'integer', required: true },
                removed: { type: 'integer', required: true },
                changed: { type: 'integer', required: true },
                unchanged: { type: 'integer', required: true },
                headTotal: { type: 'integer', required: true },
              },
            },
            added: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  identity: { type: 'string', required: true },
                  title: { type: 'string' },
                },
              },
            },
            removed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  identity: { type: 'string', required: true },
                  title: { type: 'string' },
                },
              },
            },
            pruned: { type: 'integer', required: true },
            // 注意：数组 items 节点上不能写 required —— DSL 只允许在对象属性上声明必填。
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (args, value) => {
          const lines = [];
          if (value?.snapshot === undefined) {
            return [{ type: 'text', text: 'report_save 没有返回快照信息，请检查插件配置。' }];
          }
          const s = value.snapshot;
          const label = s.label === undefined ? '' : `「${s.label}」`;
          lines.push(
            `已保存快照 #${s.index}${label} → ${value.report.name} · ${s.atLocal}`,
          );          lines.push(`条目 ${s.items}（有稳定标识 ${s.keyed} · 依赖内容哈希 ${s.hashed}）${s.bodyChars > 0 ? ` · 正文 ${s.bodyChars} 字符` : ''}`);
          lines.push(`文件：${s.file}`);
          if (value.baseline === 'none' || value.previous === undefined) {
            lines.push('这是该报告的第一个快照，没有基线可比较——全部条目都算新增。');
            if (value.counts.added > 0) lines.push(`新增 ${value.counts.added} 条。`);
          } else {
            const p = value.previous;
            lines.push(`与上一快照 #${p.index}（${p.atLocal}）相比：新增 ${value.counts.added} · 消失 ${value.counts.removed} · 变化 ${value.counts.changed} · 未变 ${value.counts.unchanged}`);
            if (value.counts.added === 0 && value.counts.removed === 0 && value.counts.changed === 0) {
              lines.push('与上次完全一致，没有新增、没有消失、没有变化。');
            }
            for (const entry of value.added) lines.push(`  + ${entry.title ?? entry.identity}`);
            for (const entry of value.removed) lines.push(`  - ${entry.title ?? entry.identity}`);
          }
          if (value.pruned > 0) lines.push(`已按 maxSnapshots 剪掉 ${value.pruned} 个最旧的快照。`);
          for (const warning of value.warnings) lines.push(`注意：${warning}`);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const report = await openReport(args.report);
        const items = Array.isArray(args.items) ? args.items : [];

        let body;
        let bodyFrom;
        if (typeof args.bodyPath === 'string' && args.bodyPath.trim() !== '') {
          const read = await readUserText(args.bodyPath, exec);
          body = read.text;
          bodyFrom = read.displayPath;
        } else if (typeof args.body === 'string') {
          body = args.body;
        }

        const bodyTruncated = typeof body === 'string' && body.length > maxBodyChars;
        if (bodyTruncated) body = body.slice(0, maxBodyChars);

        const atMs = Date.now();
        const atIso = new Date(atMs).toISOString();
        const indexOfItems = indexItems(items, identityFields);

        return withReportLock(report.slug, async () => {
          const current = await loadReport(root, report.slug);
          const previous = current.snapshots.length > 0 ? current.snapshots[current.snapshots.length - 1] : undefined;
          const baseItems = [];
          if (previous !== undefined) {
            const base = await readSnapshot(current, previous);
            if (Array.isArray(base?.items)) baseItems.push(...base.items);
          }

          const id = randomBytes(4).toString('hex');
          const file = fileNameOf(atMs, id);
          const dir = join(current.dir, 'snapshots');
          const snapshot = {
            format: SNAPSHOT_FORMAT,
            report: report.name,
            slug: report.slug,
            id,
            at: atIso,
            atMs,
            ...(typeof args.label === 'string' && args.label !== '' ? { label: args.label } : {}),
            ...(typeof args.source === 'string' && args.source !== '' ? { source: args.source } : {}),
            ...(bodyFrom === undefined ? {} : { bodyFrom }),
            ...(bodyTruncated ? { bodyTruncated: true } : {}),
            counts: { items: items.length, keyed: items.length - indexOfItems.hashed, hashed: indexOfItems.hashed },
            items,
            ...(typeof body === 'string' && body !== '' ? { body } : {}),
          };
          await writeFileAtomic(join(dir, file), `${JSON.stringify(snapshot, null, 2)}\n`);

          const entry = {
            id,
            atMs,
            at: atIso,
            file,
            index: current.snapshots.length + 1,
            items: items.length,
            ...(typeof args.label === 'string' && args.label !== '' ? { label: args.label } : {}),
            ...(typeof args.source === 'string' && args.source !== '' ? { source: args.source } : {}),
            ...(typeof body === 'string' && body !== '' ? { hasBody: true } : {}),
          };
          const snapshots = [...current.snapshots, entry];

          let pruned = 0;
          if (maxSnapshots > 0 && snapshots.length > maxSnapshots) {
            const drop = snapshots.splice(0, snapshots.length - maxSnapshots);
            for (const victim of drop) {
              await rm(join(current.dir, 'snapshots', victim.file), { force: true }).catch(() => {});
              pruned += 1;
            }
            for (const [position, remaining] of snapshots.entries()) remaining.index = position + 1;
            entry.index = snapshots.length;
          }

          await writeFileAtomic(
            join(current.dir, 'report.json'),
            `${JSON.stringify(buildManifest({ ...current, name: report.name, snapshots }, atIso), null, 2)}\n`,
          );

          const diff = buildDiff(baseItems, items, identityFields, diffLimit);
          const warnings = [];
          if (indexOfItems.hashed > 0) {
            warnings.push(
              `${indexOfItems.hashed} 条没有可用的稳定标识（${identityFields.join('/')}），已退化为内容哈希：这些条目内容一改就会同时出现在「新增」和「消失」里。给每条一个稳定的 key 可以消除这种假 diff。`,
            );
          }
          if (bodyTruncated) warnings.push(`正文超过 maxBodyChars（${maxBodyChars}），已截断。`);
          if (diff.counts.added > 10 || diff.counts.removed > 10) {
            warnings.push('回执里的新增/消失只列了前 10 条（counts 里是完整数量），完整清单用 report_diff。');
          }

          return {
            report: { name: report.name, slug: report.slug, dir: current.dir },
            snapshot: {
              id,
              at: atIso,
              atLocal: localTime(atMs),
              index: entry.index,
              items: items.length,
              keyed: items.length - indexOfItems.hashed,
              hashed: indexOfItems.hashed,
              bodyChars: typeof body === 'string' ? body.length : 0,
              bodyTruncated,
              file,
              ...(bodyFrom === undefined ? {} : { bodyFrom }),
              ...(typeof args.label === 'string' && args.label !== '' ? { label: args.label } : {}),
              ...(typeof args.source === 'string' && args.source !== '' ? { source: args.source } : {}),
            },
            ...(previous === undefined
              ? {}
              : {
                  previous: {
                    id: previous.id,
                    at: previous.at,
                    atLocal: localTime(previous.atMs),
                    index: previous.index,
                    ...(typeof previous.label === 'string' ? { label: previous.label } : {}),
                  },
                }),
            baseline: previous === undefined ? 'none' : 'auto',
            counts: {
              added: diff.counts.added,
              removed: diff.counts.removed,
              changed: diff.counts.changed,
              unchanged: diff.counts.unchanged,
              headTotal: diff.counts.headTotal,
            },
            added: diff.added.slice(0, 10).map((record) => ({
              identity: record.identity,
              ...(titleOf(record.item) === undefined ? {} : { title: titleOf(record.item) }),
            })),
            removed: diff.removed.slice(0, 10).map((record) => ({
              identity: record.identity,
              ...(titleOf(record.item) === undefined ? {} : { title: titleOf(record.item) }),
            })),
            pruned,
            warnings,
          };
        });
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `保存报告快照：${typeof args.report === 'string' ? args.report : ''}`,
        kind: 'other',
        rawInput: typeof args.label === 'string' ? args.label : '',
      }),
    }),
  );

  // ---- report_diff -------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'report_diff',
      description:
        'Structurally compare two snapshots of the same named report and report what was added, what disappeared and what changed. ' +
        'Defaults to "latest vs the one before it", which answers the recurring question "what is new since last time". ' +
        'Matching is by stable entry identity (the configured identityFields: key/id/title/name by default), never by array position, so reordered output never shows up as a change. ' +
        'A report with a single snapshot has no baseline: everything counts as added, and the result says so explicitly. ' +
        '比较同一报告的两个快照，输出新增/消失/变化的条目（默认最新 vs 上一个）。',
      parameters: {
        report: { type: 'string', required: true, description: '报告名，与 report_save 用的名字一致。' },
        from: {
          type: 'string',
          description:
            '基线快照：latest / previous（默认，取 to 的前一个）/ #N 或 N（1 起，负数从末尾数）/ 快照 id 或其前缀。',
        },
        to: { type: 'string', description: '目标快照，默认 latest（最新）。' },
        limit: { type: 'number', description: `每个分区最多返回多少条，默认取配置 diffLimit（${diffLimit}）。` },
        detail: {
          type: 'string',
          enum: ['full', 'summary'],
          description:
            'full（默认）在「变化」里带上完整的 before/after；summary 只给字段级的前后预览，适合条目很大的报告。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            report: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                name: { type: 'string', required: true },
                slug: { type: 'string', required: true },
                dir: { type: 'string', required: true },
                exists: { type: 'boolean', required: true },
              },
            },
            snapshotCount: { type: 'integer', required: true },
            from: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                at: { type: 'string', required: true },
                atLocal: { type: 'string', required: true },
                index: { type: 'integer', required: true },
                label: { type: 'string' },
              },
            },
            to: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                at: { type: 'string', required: true },
                atLocal: { type: 'string', required: true },
                index: { type: 'integer', required: true },
                label: { type: 'string' },
              },
            },
            baseline: { type: 'string', required: true, enum: ['explicit', 'auto', 'none'] },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                added: { type: 'integer', required: true },
                removed: { type: 'integer', required: true },
                changed: { type: 'integer', required: true },
                unchanged: { type: 'integer', required: true },
                baseTotal: { type: 'integer', required: true },
                headTotal: { type: 'integer', required: true },
              },
            },
            added: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  identity: { type: 'string', required: true },
                  stable: { type: 'boolean', required: true },
                  title: { type: 'string' },
                  preview: { type: 'string', required: true },
                  item: { type: 'json', required: true },
                },
              },
            },
            removed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  identity: { type: 'string', required: true },
                  stable: { type: 'boolean', required: true },
                  title: { type: 'string' },
                  preview: { type: 'string', required: true },
                  item: { type: 'json', required: true },
                },
              },
            },
            changed: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  identity: { type: 'string', required: true },
                  stable: { type: 'boolean', required: true },
                  title: { type: 'string' },
                  fields: {
                    type: 'array',
                    required: true,
                    items: {
                      type: 'object',
                      additionalProperties: false,
                      properties: {
                        field: { type: 'string', required: true },
                        from: { type: 'string', required: true },
                        to: { type: 'string', required: true },
                      },
                    },
                  },
                  before: { type: 'json' },
                  after: { type: 'json' },
                },
              },
            },
            limits: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                limit: { type: 'integer', required: true },
                truncated: { type: 'boolean', required: true },
              },
            },
            warnings: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (args, value) => {
          if (value?.report === undefined) return [{ type: 'text', text: 'report_diff 没有返回结果。' }];
          const lines = [];
          if (value.report.exists === false || value.to === undefined) {
            lines.push(`没有找到报告「${value.report.name}」的任何快照。`);
            lines.push(`查找位置：${value.report.dir}`);
            lines.push('可能名字拼错了，或者还没有用 report_save 存过。用 report_list 看看已有哪些报告。');
            return [{ type: 'text', text: lines.join('\n') }];
          }
          const head = value.to;
          const label = (entry) => (entry.label === undefined ? `#${entry.index} ${entry.atLocal}` : `#${entry.index} ${entry.atLocal}「${entry.label}」`);
          lines.push(`报告：${value.report.name}（共 ${value.snapshotCount} 个快照，目录 ${value.report.dir}）`);
          if (value.baseline === 'none' || value.from === undefined) {
            lines.push(`目标快照 ${label(head)} — 这是最早的一个快照，没有基线。`);
            lines.push(`全部 ${value.counts.headTotal} 条都计为新增。`);
          } else {
            lines.push(`对比：${label(value.from)} → ${label(head)}`);
          }
          const c = value.counts;
          lines.push(`新增 ${c.added} · 消失 ${c.removed} · 变化 ${c.changed} · 未变 ${c.unchanged}`);
          if (c.added === 0 && c.removed === 0 && c.changed === 0 && value.baseline !== 'none') {
            lines.push('两个快照在结构上完全一致：没有新增、没有消失、没有变化。');
          }
          if (value.added.length > 0) {
            lines.push('', `新增（${c.added}）：`);
            for (const entry of value.added) lines.push(`  + ${entry.title ?? entry.preview}`);
          }
          if (value.removed.length > 0) {
            lines.push('', `消失（${c.removed}）：`);
            for (const entry of value.removed) lines.push(`  - ${entry.title ?? entry.preview}`);
          }
          if (value.changed.length > 0) {
            lines.push('', `变化（${c.changed}）：`);
            for (const entry of value.changed) {
              lines.push(`  ~ ${entry.title ?? entry.identity}`);
              for (const change of entry.fields) {
                lines.push(`      ${change.field}: ${change.from || '(空)'} → ${change.to || '(空)'}`);
              }
            }
          }
          if (value.limits.truncated) lines.push('', `注意：分区内容已按 limit=${value.limits.limit} 截断，counts 里是完整数量。`);
          for (const warning of value.warnings) lines.push(`注意：${warning}`);
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        void exec;
        const report = await openReport(args.report);
        const detail = args.detail === 'summary' ? 'summary' : 'full';
        const cap = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : diffLimit;

        const base = {
          report: { name: report.name, slug: report.slug, dir: report.dir, exists: report.exists },
          snapshotCount: report.snapshots.length,
        };

        if (report.snapshots.length === 0) {
          return {
            ...base,
            baseline: 'none',
            counts: { added: 0, removed: 0, changed: 0, unchanged: 0, baseTotal: 0, headTotal: 0 },
            added: [],
            removed: [],
            changed: [],
            limits: { limit: cap, truncated: false },
            warnings: ['该报告还没有任何快照。先用 report_save 存一次。'],
          };
        }

        const wantedTo = typeof args.to === 'string' && args.to.trim() !== '' ? args.to : 'latest';
        const resolvedTo = resolveRef(report.snapshots, wantedTo, report.snapshots.length);
        if (resolvedTo.error !== undefined) {
          throw new Error(`report_diff: ${resolvedTo.error}（报告「${report.name}」共 ${report.snapshots.length} 个快照）`);
        }
        if (resolvedTo.none === true) {
          throw new Error(`report_diff: 报告「${report.name}」没有任何快照，无法比较。`);
        }
        const head = resolvedTo.snapshot;

        let baselineKind = 'auto';
        let baseEntry;
        if (typeof args.from === 'string' && args.from.trim() !== '') {
          baselineKind = 'explicit';
          const resolvedFrom = resolveRef(report.snapshots, args.from, head.index);
          if (resolvedFrom.error !== undefined) {
            throw new Error(`report_diff: ${resolvedFrom.error}（报告「${report.name}」共 ${report.snapshots.length} 个快照）`);
          }
          if (resolvedFrom.none === true) {
            baselineKind = 'none';
          } else {
            baseEntry = resolvedFrom.snapshot;
          }
        } else {
          // Position in the ordered list decides what "the previous snapshot" is; the
          // instants only order that list. Two snapshots in the same millisecond then
          // still diff against each other instead of against nothing.
          const earlier = report.snapshots.filter((snapshot) => snapshot.index < head.index);
          baseEntry = earlier.length > 0 ? earlier[earlier.length - 1] : undefined;
          if (baseEntry === undefined) baselineKind = 'none';
        }

        const headDocument = await readSnapshot(report, head);
        const headItems = Array.isArray(headDocument?.items) ? headDocument.items : [];
        let baseItems = [];
        if (baseEntry !== undefined) {
          const baseDocument = await readSnapshot(report, baseEntry);
          baseItems = Array.isArray(baseDocument?.items) ? baseDocument.items : [];
        }

        const diff = buildDiff(baseItems, headItems, identityFields, cap);
        const warnings = [];
        if (diff.hashedHead > 0) {
          warnings.push(
            `${diff.hashedHead} 条当前条目没有可用的稳定标识（${identityFields.join('/')}），按内容哈希配对：内容一改就会同时算作「新增」和「消失」。这不是真实变化，但插件无法区分。`,
          );
        }
        if (baseEntry !== undefined && head.index <= baseEntry.index) {
          warnings.push('基线并不早于目标快照，差异方向可能与直觉相反。');
        }

        const view = (entry) => ({
          id: entry.id,
          at: entry.at,
          atLocal: localTime(entry.atMs),
          index: entry.index,
          ...(typeof entry.label === 'string' ? { label: entry.label } : {}),
        });

        return {
          ...base,
          ...(baseEntry === undefined ? {} : { from: view(baseEntry) }),
          to: view(head),
          baseline: baselineKind,
          counts: diff.counts,
          added: diff.added.map((record) => ({
            identity: record.identity,
            stable: record.stable,
            preview: previewOf(record.item, 160),
            item: record.item,
            ...(titleOf(record.item) === undefined ? {} : { title: titleOf(record.item) }),
          })),
          removed: diff.removed.map((record) => ({
            identity: record.identity,
            stable: record.stable,
            preview: previewOf(record.item, 160),
            item: record.item,
            ...(titleOf(record.item) === undefined ? {} : { title: titleOf(record.item) }),
          })),
          changed: diff.changed.map((record) => ({
            identity: record.identity,
            stable: record.stable,
            fields: record.fields,
            ...(titleOf(record.after) === undefined ? {} : { title: titleOf(record.after) }),
            ...(detail === 'full' ? { before: record.before, after: record.after } : {}),
          })),
          limits: { limit: cap, truncated: diff.truncated },
          warnings,
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `报告差异：${typeof args.report === 'string' ? args.report : ''}`,
        kind: 'read',
        rawInput: typeof args.from === 'string' ? args.from : '',
      }),
    }),
  );

  // ---- report_list -------------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'report_list',
      description:
        'List the named reports kept by this plugin, and optionally every snapshot of one report. ' +
        'Use it to discover the exact report name to diff, or to see how many runs a target has accumulated. ' +
        '列出已保存的报告（及各报告的快照时间线）。',
      parameters: {
        report: { type: 'string', description: '可选：只看这一个报告，并列出它的全部快照。' },
        limit: { type: 'number', description: '最多列出多少个报告或快照，默认 50。' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            dir: { type: 'string', required: true },
            count: { type: 'integer', required: true },
            reports: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  name: { type: 'string', required: true },
                  slug: { type: 'string', required: true },
                  snapshots: { type: 'integer', required: true },
                  items: { type: 'integer', required: true },
                  createdAt: { type: 'string', required: true },
                  updatedAt: { type: 'string', required: true },
                  latestAt: { type: 'string', required: true },
                  latestAtLocal: { type: 'string', required: true },
                  latestLabel: { type: 'string' },
                },
              },
            },
            selected: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                slug: { type: 'string', required: true },
                exists: { type: 'boolean', required: true },
                snapshots: { type: 'integer', required: true },
              },
            },
            snapshots: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  at: { type: 'string', required: true },
                  atLocal: { type: 'string', required: true },
                  index: { type: 'integer', required: true },
                  items: { type: 'integer', required: true },
                  hasBody: { type: 'boolean', required: true },
                  label: { type: 'string' },
                  source: { type: 'string' },
                },
              },
            },
          },
        },
        render: (args, value) => {
          const lines = [];
          if (value?.dir === undefined) return [{ type: 'text', text: 'report_list 没有返回结果。' }];
          if (value.selected !== undefined && value.selected.exists === false) {
            lines.push(`没有找到报告「${value.selected.name}」。状态目录：${value.dir}`);
            if (value.count > 0) {
              lines.push(`已存在的报告（${value.count} 个）：${value.reports.map((report) => report.name).join('、')}`);
            } else {
              lines.push('目前一个报告都还没有。用 report_save 存第一个快照即可建报告。');
            }
            return [{ type: 'text', text: lines.join('\n') }];
          }
          if (value.count === 0) {
            lines.push(`还没有任何报告。状态目录：${value.dir}`);
            lines.push('用 report_save 存第一个快照即可建报告，例如：report_save({ report: "edusrc报告", items: [...] })。');
            return [{ type: 'text', text: lines.join('\n') }];
          }
          lines.push(`共 ${value.count} 个报告 · 状态目录 ${value.dir}`);
          for (const report of value.reports) {
            const label = report.latestLabel === undefined ? '' : `「${report.latestLabel}」`;
            lines.push(
              `  ${report.name}（${report.slug}）— ${report.snapshots} 个快照 · 最新 ${report.latestAtLocal} ${label} · ${report.items} 条`,
            );
          }
          if (Array.isArray(value.snapshots)) {
            if (value.snapshots.length === 0) {
              lines.push(`报告「${value.selected?.name ?? ''}」还没有快照。`);
            } else {
              lines.push(`${value.selected?.name ?? ''} 的快照时间线：`);
              for (const snapshot of value.snapshots) {
                const label = snapshot.label === undefined ? '' : `「${snapshot.label}」`;
                const body = snapshot.hasBody ? ' · 含正文' : '';
                lines.push(`  #${snapshot.index} ${snapshot.atLocal} ${label} — ${snapshot.id} · ${snapshot.items} 条${body}`);
              }
            }
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const cap = Number.isFinite(args.limit) && args.limit > 0 ? Math.floor(args.limit) : 50;

        const folder = join(root, 'reports');
        let entries = [];
        try {
          entries = await readdir(folder, { withFileTypes: true });
        } catch {
          entries = [];
        }

        const wanted = typeof args.report === 'string' && args.report.trim() !== '' ? slugify(args.report) : undefined;
        // Enumerate EVERY report even when one was requested: a typo has to come back
        // with the list of names that do exist, otherwise the hint is useless.
        const allSlugs = entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .sort();

        const reports = [];
        let selected;
        let snapshots;
        for (const slug of allSlugs.slice(0, cap)) {
          const report = await loadReport(root, slug);
          if (report.snapshots.length === 0) continue;
          const latest = await hydrateSnapshot(report, report.snapshots[report.snapshots.length - 1]);
          reports.push({
            name: report.name,
            slug: report.slug,
            snapshots: report.snapshots.length,
            items: latest.items,
            createdAt: report.createdAt ?? report.snapshots[0].at,
            updatedAt: latest.at,
            latestAt: latest.at,
            latestAtLocal: localTime(latest.atMs),
            ...(typeof latest.label === 'string' ? { latestLabel: latest.label } : {}),
          });
          if (wanted !== undefined && slug === wanted) {
            selected = { name: report.name, slug: report.slug, exists: true, snapshots: report.snapshots.length };
            snapshots = [];
            for (const snapshot of report.snapshots) {
              await hydrateSnapshot(report, snapshot);
              snapshots.push({
                id: snapshot.id,
                at: snapshot.at,
                atLocal: localTime(snapshot.atMs),
                index: snapshot.index,
                items: snapshot.items,
                hasBody: snapshot.hasBody === true,
                ...(typeof snapshot.label === 'string' ? { label: snapshot.label } : {}),
                ...(typeof snapshot.source === 'string' ? { source: snapshot.source } : {}),
              });
            }
          }
        }

        if (wanted !== undefined && selected === undefined) {
          selected = { name: args.report, slug: wanted, exists: false, snapshots: 0 };
          snapshots = [];
        }

        return {
          dir: folder,
          count: reports.length,
          reports,
          ...(selected === undefined ? {} : { selected }),
          ...(snapshots === undefined ? {} : { snapshots }),
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `报告列表${typeof args.report === 'string' && args.report !== '' ? `：${args.report}` : ''}`,
        kind: 'read',
        rawInput: '',
      }),
    }),
  );

  // ---- report_render -----------------------------------------------------
  ctx.tools.register(
    defineTool({
      name: 'report_render',
      description:
        'Render one snapshot of a named report as a complete Markdown document: header, change section against the previous snapshot, the full entry table and the stored body. ' +
        'Returns the Markdown to the model and can also write it to a path you choose (through the deployment filesystem service, respecting its write policy). ' +
        'Use it when the user wants something readable or shareable rather than raw JSON. ' +
        '把一个快照渲染成完整 Markdown（含本次变更章节），可直接返回或写入指定路径。',
      parameters: {
        report: { type: 'string', required: true, description: '报告名。' },
        snapshot: {
          type: 'string',
          description: '要渲染的快照：latest（默认）/ previous / #N 或 N / 快照 id 或其前缀。',
        },
        writePath: {
          type: 'string',
          description:
            '可选：把 Markdown 写入该路径（需要部署挂载了 fs 服务，并遵守其「先读后写」策略；建议用带日期戳的新文件名）。',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            report: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                name: { type: 'string', required: true },
                slug: { type: 'string', required: true },
                dir: { type: 'string', required: true },
              },
            },
            exists: { type: 'boolean', required: true },
            snapshot: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                at: { type: 'string', required: true },
                atLocal: { type: 'string', required: true },
                index: { type: 'integer', required: true },
                items: { type: 'integer', required: true },
                bodyChars: { type: 'integer', required: true },
                label: { type: 'string' },
              },
            },
            baseline: { type: 'string', required: true, enum: ['auto', 'none'] },
            counts: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                added: { type: 'integer', required: true },
                removed: { type: 'integer', required: true },
                changed: { type: 'integer', required: true },
                unchanged: { type: 'integer', required: true },
                headTotal: { type: 'integer', required: true },
              },
            },
            markdown: { type: 'string', required: true },
            markdownChars: { type: 'integer', required: true },
            markdownTruncated: { type: 'boolean', required: true },
            written: {
              type: 'object',
              additionalProperties: false,
              properties: {
                path: { type: 'string', required: true },
                chars: { type: 'integer', required: true },
              },
            },
          },
        },
        render: (args, value) => {
          if (value?.report === undefined) return [{ type: 'text', text: 'report_render 没有返回结果。' }];
          if (value.exists === false || value.snapshot === undefined) {
            return [
              {
                type: 'text',
                text:
                  `没有找到报告「${value.report.name}」的任何快照（查找位置 ${value.report.dir}）。` +
                  '可能名字拼错了，或者还没有用 report_save 存过；用 report_list 看看已有哪些报告。',
              },
            ];
          }
          const s = value.snapshot;
          const lines = [];
          const label = s.label === undefined ? '' : `「${s.label}」`;
          lines.push(`已渲染 ${value.report.name} 的快照 #${s.index} ${label}（${s.atLocal}）`);
          lines.push(`Markdown ${value.markdownChars.toLocaleString()} 字符 · 条目 ${s.items} 条${s.bodyChars > 0 ? ` · 正文 ${s.bodyChars} 字符` : ''}`);
          if (value.baseline === 'none') {
            lines.push(`与基线相比：新增 ${value.counts.added}（该快照没有更早的基线，全部计为新增）`);
          } else {
            lines.push(`与上一快照相比：新增 ${value.counts.added} · 消失 ${value.counts.removed} · 变化 ${value.counts.changed} · 未变 ${value.counts.unchanged}`);
          }
          if (value.written !== undefined) {
            lines.push(`已写入 ${value.written.path}（${value.written.chars.toLocaleString()} 字符）`);
          } else if (typeof args.writePath === 'string' && args.writePath !== '') {
            lines.push('未写文件。');
          }
          if (value.markdownTruncated) {
            lines.push(`注意：返回的 Markdown 已按 maxRenderChars 截断，${value.written === undefined ? '写文件时会写完整正文' : '写入文件的是完整正文'}。`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args, exec) {
        const report = await openReport(args.report);
        const base = { report: { name: report.name, slug: report.slug, dir: report.dir } };

        if (report.snapshots.length === 0) {
          return {
            ...base,
            exists: false,
            baseline: 'none',
            counts: { added: 0, removed: 0, changed: 0, unchanged: 0, headTotal: 0 },
            markdown: '',
            markdownChars: 0,
            markdownTruncated: false,
          };
        }

        const wanted = typeof args.snapshot === 'string' && args.snapshot.trim() !== '' ? args.snapshot : 'latest';
        const resolved = resolveRef(report.snapshots, wanted, report.snapshots.length);
        if (resolved.error !== undefined) {
          throw new Error(`report_render: ${resolved.error}（报告「${report.name}」共 ${report.snapshots.length} 个快照）`);
        }
        if (resolved.none === true) {
          throw new Error(`report_render: 报告「${report.name}」还没有任何快照。`);
        }
        const head = resolved.snapshot;
        const earlier = report.snapshots.filter((snapshot) => snapshot.index < head.index);
        const previous = earlier.length > 0 ? earlier[earlier.length - 1] : undefined;

        const document = await readSnapshot(report, head);
        const items = Array.isArray(document?.items) ? document.items : [];
        let baseItems = [];
        if (previous !== undefined) {
          const baseDocument = await readSnapshot(report, previous);
          baseItems = Array.isArray(baseDocument?.items) ? baseDocument.items : [];
        }

        const diff = buildDiff(baseItems, items, identityFields, Number.MAX_SAFE_INTEGER);
        const markdown = renderMarkdown({
          report,
          snapshot: {
            id: head.id,
            index: head.index,
            atMs: head.atMs,
            at: head.at,
            items,
            ...(typeof document?.body === 'string' ? { body: document.body } : {}),
            ...(typeof head.label === 'string' ? { label: head.label } : {}),
            ...(typeof head.source === 'string' ? { source: head.source } : {}),
          },
          from: previous === undefined ? undefined : { id: previous.id, index: previous.index, atMs: previous.atMs },
          diff,
          identityFields,
        });

        let written;
        if (typeof args.writePath === 'string' && args.writePath.trim() !== '') {
          written = await writeUserText(args.writePath, markdown, exec);
        }

        const truncated = markdown.length > maxRenderChars;
        return {
          ...base,
          exists: true,
          snapshot: {
            id: head.id,
            at: head.at,
            atLocal: localTime(head.atMs),
            index: head.index,
            items: items.length,
            bodyChars: typeof document?.body === 'string' ? document.body.length : 0,
            ...(typeof head.label === 'string' ? { label: head.label } : {}),
          },
          baseline: previous === undefined ? 'none' : 'auto',
          counts: {
            added: diff.counts.added,
            removed: diff.counts.removed,
            changed: diff.counts.changed,
            unchanged: diff.counts.unchanged,
            headTotal: diff.counts.headTotal,
          },
          markdown: truncated ? markdown.slice(0, maxRenderChars) : markdown,
          markdownChars: markdown.length,
          markdownTruncated: truncated,
          ...(written === undefined ? {} : { written }),
        };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `渲染报告：${typeof args.report === 'string' ? args.report : ''}`,
        kind: 'read',
        rawInput: typeof args.snapshot === 'string' ? args.snapshot : '',
      }),
    }),
  );
}

// Loader 读的是命名导出；apply 必须以具名方式导出，否则插件不会装配（且没有任何报错）。
export { Config, apply, inject, name };
