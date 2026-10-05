/**
 * 契约自检：把这个 DSH 插件的静默失败点钉死。
 *
 * 这些错误的共同点是**不报错**——插件看上去装好了，实际什么都没做：
 *   1. 只用 `export default` → Loader 的 unwrapExports 折叠它并丢掉 `inject`
 *   2. 漏掉命名导出 → apply 从未被调用
 *   3. `package.json` 少了 `dsh.bundle.patch` 或 `files` 里漏了补丁文件 → 装了不挂载
 *   4. 工具参数规格无法被 defineTool 规范化 → 运行时才炸
 *   5. 工具输出里出现 `undefined` / 非有限数字 → 真实运行时 `snapshotToolValue` 直接
 *      抛 ToolOutputError（这一条最容易在「可选字段」上踩到，所以这里逐值走一遍）
 *   6. 空数据下 execute / render 抛错 → 第一次真实调用才炸
 *
 * 设计：**静态检查零依赖**，因此在没装 DSH 的 CI 里也能跑（靠后的装配与端到端检查
 * 在解析得到 `@deepseek-ai/*` 时才执行，否则打印 SKIP 并仍然退出 0）。本地开发时
 * 用 `--strict` 让「依赖解析不到」变成失败，避免把跳过误当成通过。
 *
 * 装配与端到端部分全部在系统临时目录里跑，绝不碰真实的 ~/.dsh/report-studio，
 * 结束后删除临时目录。
 */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const entry = join(root, 'index.js');
const strict = process.argv.includes('--strict');

let failures = 0;
let skipped = 0;
const pass = (msg) => console.log(`  \u2713 ${msg}`);
const skip = (msg) => {
  skipped += 1;
  console.log(`  \u25CB SKIP ${msg}`);
};
const fail = (msg) => {
  failures += 1;
  console.error(`  \u2717 ${msg}`);
};

console.log('DSH 插件契约自检\n');

/**
 * 去掉注释后再做文本匹配。这个脚本自己就会在文档里提到 `export default`，
 * 不剥离注释会把自己判成违规。
 * @param text - 源码全文。
 * @returns 注释被替换成空白的源码，保留原有换行以便定位。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, ' '))
    .replace(/(^|[^:])\/\/[^\n]*/g, (match, prefix) => prefix + ' '.repeat(match.length - prefix.length));
}

// ---- 1. 静态检查：导出形态与打包契约 ------------------------------------
console.log('静态检查（不需要依赖）');

const source = await readFile(entry, 'utf8');
const code = stripComments(source);

if (/export\s+default\b/.test(code)) {
  fail('发现 `export default` —— Loader 会折叠它并静默丢掉 inject');
} else {
  pass('没有 export default');
}

const exportStatement = /export\s*\{([^}]*)\}/.exec(code);
const exportedNames =
  exportStatement === null
    ? []
    : exportStatement[1]
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== '');

for (const required of ['apply', 'inject', 'name', 'Config']) {
  if (exportedNames.includes(required)) pass(`命名导出包含 ${required}`);
  else if (required === 'Config') fail('命名导出缺少 Config —— 配置层不可编辑');
  else fail(`命名导出缺少 ${required} —— 插件不会装配`);
}

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));

if (manifest.type === 'module') pass('纯 ESM（type: module）');
else fail(`package.json 的 type 是 ${manifest.type}，应为 module`);

if (manifest.dependencies === undefined || Object.keys(manifest.dependencies).length === 0) {
  pass('零运行时依赖');
} else {
  fail(`存在运行时依赖：${Object.keys(manifest.dependencies).join(', ')}`);
}

const patchPath = manifest.dsh?.bundle?.patch;
if (typeof patchPath === 'string' && patchPath !== '') {
  pass(`dsh.bundle.patch = ${patchPath}`);
  if (manifest.files?.includes(patchPath.replace(/^\.\//, '')) === true) {
    pass('files 包含补丁文件 —— 否则发布出去装了不挂载');
  } else {
    fail(`files ${JSON.stringify(manifest.files)} 未包含 ${patchPath}`);
  }
  if (existsSync(join(root, patchPath))) pass('补丁文件真实存在');
  else fail(`补丁文件不存在：${patchPath}`);
  const patch = await readFile(join(root, patchPath), 'utf8');
  if (patch.includes(`'${manifest.name}'`)) {
    pass('补丁里的挂载名与包名一致');
  } else {
    fail(`补丁里的 name 不是 '${manifest.name}' —— 装了会报「找不到插件」`);
  }
  if (/^\s*- insert:/m.test(patch)) pass('补丁使用 insert 语义');
  else fail('补丁缺少 insert 段');
} else {
  fail('package.json 缺少 dsh.bundle.patch —— 装了不挂载');
}

/**
 * 读一个可能不存在的文本文件；缺失时返回空串，让检查以「违规」而不是「崩溃」收场。
 * @param path - 文件路径。
 * @returns 文件内容，或空串。
 */
async function readTextIfPresent(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

const ignore = await readTextIfPresent(join(root, '.gitignore'));
if (/^node_modules\/$/m.test(ignore)) pass('.gitignore 忽略 node_modules/（本地是软链，不能提交）');
else fail('.gitignore 缺少 node_modules/ —— 软链会被 git 收进去');

// 裸导入白名单：node 内建 + DSH 提供的 peer。多出来的就是隐藏的运行时依赖。
const allowedPeers = new Set(Object.keys(manifest.peerDependencies ?? {}));
const imports = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1]);
const outside = imports.filter(
  (spec) => !spec.startsWith('node:') && !allowedPeers.has(spec),
);
if (outside.length === 0) pass(`裸导入全部在白名单内（${[...new Set(imports)].filter((s) => !s.startsWith('node:')).join(', ')}）`);
else fail(`出现未声明的裸导入：${outside.join(', ')}`);

// ---- 2. 运行时检查：真实加载 ---------------------------------------------
console.log('\n运行时检查');

let mod;
let validateJsonSchemaValue;
try {
  mod = await import(new URL('../index.js', import.meta.url).href);
  ({ validateJsonSchemaValue } = await import('@deepseek-ai/dsh-tools'));
} catch (error) {
  const line = `模块无法加载：${error.code ?? ''} ${error.message.split('\n')[0]}`;
  if (strict) fail(line);
  else skip(`${line} —— 未解析到 @deepseek-ai/*，只跑了静态检查`);
  if (error.code === 'ERR_MODULE_NOT_FOUND') {
    console.error(
      '    → 裸导入解析不到。本地开发时在插件目录建一个指向 DSH node_modules 的软链：\n' +
        '      mklink /J node_modules "<DSH>/resources/app/dsh/node_modules"   (Windows)\n' +
        '      ln -s "<DSH>/resources/app/dsh/node_modules" node_modules      (macOS/Linux)',
    );
  }
  console.log(`\n结果：${failures === 0 ? `静态检查全部通过（${skipped} 项跳过）` : `${failures} 项失败`}`);
  process.exit(failures === 0 ? 0 : 1);
}

if (typeof mod.apply === 'function') pass('apply 是可调用的函数');
else fail(`apply 类型为 ${typeof mod.apply}，应为 function`);

if (Array.isArray(mod.inject)) pass(`inject 是数组：${JSON.stringify(mod.inject)}`);
else fail('inject 不是数组');

if (mod.name === undefined || mod.name === '') fail('name 为空');
else pass(`name = ${mod.name}`);

if (mod.Config !== undefined) pass('Config 已导出（设置界面可编辑）');
else fail('Config 未导出');

if (mod.default === undefined) pass('运行时无 default 导出');
else fail('运行时存在 default 导出');

// ---- 3. 装配检查：注册工具 + 空态 ----------------------------------------
console.log('\n装配检查');

/**
 * 递归断言「可无损 JSON 化」：真实运行时用 snapshotJsonValue 卡这一关，
 * 任何 undefined / NaN / Infinity / -0 / 类实例都会让整个工具调用失败。
 * @param value - 待检查的值。
 * @param path - 出错时报告的位置。
 * @returns 违规描述列表。
 */
function losslessViolations(value, path = 'value') {
  if (value === null) return [];
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return [];
  if (kind === 'number') {
    if (!Number.isFinite(value)) return [`${path} 不是有限数字：${value}`];
    if (Object.is(value, -0)) return [`${path} 是 -0，JSON 往返后会变成 0`];
    return [];
  }
  if (kind !== 'object') return [`${path} 的类型是 ${kind}，无法无损 JSON 化`];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => losslessViolations(item, `${path}[${index}]`));
  }
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    return [`${path} 不是普通对象（原型被污染）`];
  }
  return Object.entries(value).flatMap(([key, item]) => losslessViolations(item, `${path}.${key}`));
}

/**
 * @param value - 工具返回值。
 * @param schema - defineTool 编译出的输出 schema。
 * @param label - 断言标签。
 */
function assertOutput(value, schema, label) {
  const schemaViolations = validateJsonSchemaValue(schema, value, 'value');
  if (schemaViolations.length === 0) pass(`${label}：输出符合 output.schema`);
  else fail(`${label}：输出违反 output.schema —— ${schemaViolations.join('; ')}`);
  const jsonViolations = losslessViolations(value);
  if (jsonViolations.length === 0) pass(`${label}：输出可无损 JSON 化`);
  else fail(`${label}：输出无法无损 JSON 化 —— ${jsonViolations.join('; ')}`);
}

const temp = await mkdtemp(join(tmpdir(), 'dsh-report-studio-check-'));
const stateDir = join(temp, 'state');

/** 收集注册到的工具。 */
const tools = new Map();
/** 模拟 ctx：只有 tools 与可选的 inject，可选 fs 的回调故意不触发。 */
const fakeCtx = {
  tools: { register: (definition) => tools.set(definition.name, definition) },
  inject: () => {},
};

try {
  try {
    mod.apply(fakeCtx, {
      dir: stateDir,
      identityFields: ['key', 'id', 'title', 'name'],
      diffLimit: 50,
      maxSnapshots: 0,
      maxBodyChars: 100000,
      maxRenderChars: 60000,
    });
    pass('apply 执行无异常（ctx 没有 fs 服务，插件仍完整装配）');
  } catch (error) {
    fail(`apply 抛错：${error.message}`);
  }

  const expected = ['report_save', 'report_diff', 'report_list', 'report_render'];
  for (const toolName of expected) {
    if (tools.has(toolName)) pass(`工具已注册：${toolName}`);
    else fail(`工具未注册：${toolName}`);
  }

  for (const [toolName, tool] of tools) {
    const properties = tool.output?.schema?.properties;
    if (properties !== undefined && Object.keys(properties).length > 0) {
      pass(`${toolName} 输出 schema 有 ${Object.keys(properties).length} 个字段`);
    } else {
      fail(`${toolName} 输出 schema 为空 —— 模型拿不到结构化结果`);
    }
    if (tool.parameters?.type === 'object' && Object.keys(tool.parameters.properties ?? {}).length > 0) {
      pass(`${toolName} 参数规格已规范化（${Object.keys(tool.parameters.properties).join(', ')}）`);
    } else {
      fail(`${toolName} 参数规格未规范化`);
    }
  }

  /** 跑一次工具：执行 → schema/lossless 断言 → render 必须给文本。 */
  const run = async (toolName, args, label = '空态') => {
    const tool = tools.get(toolName);
    let value;
    try {
      value = await tool.execute(args, { signal: undefined });
    } catch (error) {
      fail(`${toolName} 执行抛错：${error.message}`);
      return undefined;
    }
    assertOutput(value, tool.output.schema, `${toolName}（${label}）`);
    try {
      const blocks = tool.output.render(args, value);
      const text = blocks?.[0]?.text;
      if (typeof text === 'string' && text !== '') pass(`${toolName}（${label}）render 返回了文本：${JSON.stringify(text.split('\n')[0].slice(0, 56))}`);
      else fail(`${toolName}（${label}）render 未返回文本`);
    } catch (error) {
      fail(`${toolName}（${label}）render 抛错：${error.message}`);
    }
    return value;
  };

  console.log('\n空态检查（状态目录里什么都没有）');
  await run('report_list', {});
  await run('report_diff', { report: '还不存在的报告' });
  await run('report_render', { report: '还不存在的报告' });
  await run('report_save', { report: '空报告', items: [] });

  // ---- 4. 端到端：保存 A → 保存 B → diff → render ------------------------
  console.log('\n端到端往返（真实写文件到临时目录）');

  const buildItems = (variant) => [
    { key: 'https://a.example/login', title: '登录处 SQL 注入', severity: variant === 1 ? 'medium' : 'high', target: '10.0.0.5' },
    { key: 'https://a.example/api/v1/user', title: '越权读取用户信息', severity: 'high', target: '10.0.0.5' },
    ...(variant === 1 ? [] : [{ key: 'https://a.example/upload', title: '任意文件上传', severity: 'critical', target: '10.0.0.9' }]),
  ];

  const first = await run('report_save', { report: 'edusrc报告', label: '第一次扫描', source: '自检', items: buildItems(1) }, '快照 A');
  const second = await run(
    'report_save',
    {
      report: 'edusrc报告',
      label: '第二次扫描',
      source: '自检',
      body: '# 复测小结\n\n上次的中危升级成高危。',
      items: buildItems(2),
    },
    '快照 B',
  );
  const diff = await run('report_diff', { report: 'edusrc报告' }, 'A→B');
  const rendered = await run('report_render', { report: 'edusrc报告' }, 'A→B');
  await run('report_list', { report: 'edusrc报告' }, 'A→B');

  const snapshotDir = join(stateDir, 'reports', 'edusrc报告', 'snapshots');
  const files = await readdir(snapshotDir).catch(() => []);
  if (files.length === 2) pass(`快照目录里有 2 个快照文件：${files.join(', ')}`);
  else fail(`快照目录里应有 2 个文件，实际 ${files.length} 个：${files.join(', ')}`);
  if (files.every((file) => !file.startsWith('.tmp-'))) pass('没有残留的临时文件（原子写收尾正常）');
  else fail(`发现残留临时文件：${files.filter((f) => f.startsWith('.tmp-')).join(', ')}`);

  if (first?.snapshot !== undefined && first.snapshot.keyed === 2 && first.snapshot.hashed === 0) {
    pass('第一次保存：2 条都有稳定标识');
  } else {
    fail('第一次保存的稳定标识统计不对');
  }
  if (first?.baseline === 'none' && first.counts.added === 2) pass('第一个快照：无基线，2 条计为新增');
  else fail(`第一个快照的基线语义不对：baseline=${first?.baseline} added=${first?.counts?.added}`);

  if (
    second?.counts.added === 1 &&
    second.counts.removed === 0 &&
    second.counts.changed === 1 &&
    second.counts.unchanged === 1
  ) {
    pass('第二次保存：新增 1 · 消失 0 · 变化 1 · 未变 1（与预期一致）');
  } else {
    fail(`第二次保存的差异不对：${JSON.stringify(second?.counts)}`);
  }

  if (diff?.counts.added === 1 && diff.counts.removed === 0 && diff.counts.changed === 1 && diff.counts.unchanged === 1) {
    pass('report_diff 复现了同一组差异');
  } else {
    fail(`report_diff 结果不一致：${JSON.stringify(diff?.counts)}`);
  }
  if (diff?.changed?.[0]?.fields?.some((change) => change.field === 'severity' && change.to === 'high')) {
    pass('字段级变化定位到 severity: medium → high');
  } else {
    fail('字段级变化没有定位到 severity');
  }

  if (typeof rendered?.markdown === 'string' && rendered.markdown.includes('## 本次变更') && rendered.markdown.includes('新增 1')) {
    pass(`report_render 生成了完整 Markdown（${rendered.markdownChars} 字符）`);
  } else {
    fail('report_render 生成的 Markdown 不完整');
  }

  // 稳定的标识 → 顺序变化不产生假 diff。
  const reordered = await run(
    'report_save',
    { report: 'edusrc报告', label: '顺序打乱', items: [...buildItems(2)].reverse() },
    '打乱顺序',
  );
  if (reordered?.counts.added === 0 && reordered.counts.removed === 0 && reordered.counts.changed === 0) {
    pass('把条目顺序倒过来：新增/消失/变化都是 0（diff 按标识配对，不看下标）');
  } else {
    fail(`顺序变化产生了假 diff：${JSON.stringify(reordered?.counts)}`);
  }
} finally {
  await rm(temp, { recursive: true, force: true }).catch(() => {});
}

// ---- 5. 可选 fs 分支 ------------------------------------------------------
console.log('\n可选依赖检查');

const noFsDir = join(tmpdir(), 'dsh-report-studio-check-unused');
const toolsWithoutFs = new Map();
mod.apply(
  { tools: { register: (definition) => toolsWithoutFs.set(definition.name, definition) }, inject: () => {} },
  { dir: noFsDir },
);
try {
  await toolsWithoutFs.get('report_save').execute({ report: 'x', bodyPath: join(tmpdir(), 'nope.md') }, {});
  fail('没有 fs 服务时 bodyPath 竟然成功了');
} catch (error) {
  if (/fs 服务/.test(error.message)) pass('没有 fs 服务时 bodyPath 给出可读提示，而不是静默失败');
  else fail(`没有 fs 服务时的报错不清楚：${error.message}`);
}

/**
 * 最小 fs 服务替身，按 `@deepseek-ai/dsh-fs` 的形状实现本插件真正用到的那三个方法：
 * `resolve(path, { cwd })` → `{ targetKey, displayPath }`、`readText(target)`、
 * `writeText(target, content, intent, signal)`。用来在无 DSH 会话的情况下验证
 * bodyPath / writePath 两条分支（真实部署里这些由 fs-local 或 fs-sandbox 提供）。
 */
const fakeFs = {
  async resolve(path, options) {
    const absolute = isAbsolute(path) ? path : join(options?.cwd ?? process.cwd(), path);
    return { targetKey: absolute, displayPath: absolute };
  },
  async readText(target) {
    return readFile(String(target.targetKey), 'utf8');
  },
  async writeText(target, content) {
    const absolute = String(target.targetKey);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
    return { version: 'stub-1' };
  },
};

const fsTemp = await mkdtemp(join(tmpdir(), 'dsh-report-studio-fs-'));
try {
  const toolsWithFs = new Map();
  let sawWriteIntent = false;
  mod.apply(
    {
      tools: { register: (definition) => toolsWithFs.set(definition.name, definition) },
      // 与 cordis 的 ctx.inject(deps, callback) 同形：依赖可用时用作用域 ctx 回调。
      inject: (deps, callback) => {
        if (deps.includes('fs')) callback({ fs: fakeFs });
      },
      // 与真实写入路径一致：先过 fs/write-intent 瀑布，再写。
      waterfall: async (event, ...rest) => {
        if (event === 'fs/write-intent') sawWriteIntent = true;
        return rest[rest.length - 1]();
      },
    },
    { dir: join(fsTemp, 'state') },
  );

  const bodyFile = join(fsTemp, '正文.md');
  await writeFile(bodyFile, '# 手工正文\n\n来自一个真实文件。', 'utf8');
  const saved = await toolsWithFs.get('report_save').execute(
    { report: 'fs报告', bodyPath: bodyFile, items: [{ key: 'k1', title: '条目一' }] },
    {},
  );
  if (saved.snapshot.bodyChars > 0 && saved.snapshot.bodyFrom === bodyFile) {
    pass(`bodyPath 通过 fs 服务读入正文（${saved.snapshot.bodyChars} 字符，来自 ${saved.snapshot.bodyFrom}）`);
  } else {
    fail(`bodyPath 没有读入正文：${JSON.stringify(saved.snapshot)}`);
  }

  const outFile = join(fsTemp, 'output', '报告.md');
  const renderValue = await toolsWithFs.get('report_render').execute({ report: 'fs报告', writePath: outFile }, {});
  if (sawWriteIntent) pass('写入前经过了 fs/write-intent 瀑布（不绕过部署的写策略）');
  else fail('写入没有经过 fs/write-intent 瀑布');
  const written = await readFile(outFile, 'utf8').catch(() => '');
  if (renderValue.written?.path === outFile && written.includes('## 本次变更')) {
    pass(`writePath 通过 fs 服务写出完整 Markdown（${written.length} 字符）`);
  } else {
    fail(`writePath 没有写出 Markdown：${JSON.stringify(renderValue.written)}`);
  }
} finally {
  await rm(fsTemp, { recursive: true, force: true }).catch(() => {});
  await rm(noFsDir, { recursive: true, force: true }).catch(() => {});
}

// ---- 6. 真实 cordis 装配 ---------------------------------------------------
// 前面几节用的是手写 ctx 替身。这一节用 DSH 自带的真 cordis 跑一遍，专门验证本插件
// 最容易无声失效的设计决定：fs 是可选依赖。
//   - tools 在、fs 不在 → fiber 必须是 ACTIVE（写进 inject 就会停在 PENDING 并消失）
//   - fs 之后再注册    → 作用域 inject 回调，bodyPath/writePath 生效
//   - fs 被卸载        → 引用被清理，回到可读报错，而不是打到已处置的服务上
console.log('\n真实 cordis 装配检查');

const FIBER_STATE = ['PENDING', 'LOADING', 'ACTIVE', 'FAILED', 'DISPOSED', 'UNLOADING'];

try {
  const { Context, Service } = await import('@deepseek-ai/cordis');
  const cordisTemp = await mkdtemp(join(tmpdir(), 'dsh-report-studio-cordis-'));
  try {
    const root = new Context();
    const registered = new Map();

    class ToolsService extends Service {
      constructor(ctx) {
        super(ctx, 'tools');
      }
      register(definition) {
        registered.set(definition.name, definition);
      }
    }

    const toolsFiber = root.plugin((ctx) => {
      new ToolsService(ctx);
    });
    await toolsFiber;
    if (toolsFiber.state === 2) pass('tools 服务已提供，根上下文可用');
    else fail(`tools 服务 fiber 状态是 ${FIBER_STATE[toolsFiber.state]}`);

    const fiber = root.plugin(mod, { dir: join(cordisTemp, 'state') });
    await fiber;
    if (fiber.state === 2) pass(`插件 fiber 状态 ACTIVE（inject=${JSON.stringify(mod.inject)}，此时没有任何 fs 服务）`);
    else fail(`插件 fiber 状态是 ${FIBER_STATE[fiber.state]} —— 无 fs 时插件没有装配起来`);
    if (registered.size === 4) pass(`真 cordis 下注册了 ${registered.size} 个工具：${[...registered.keys()].join(', ')}`);
    else fail(`真 cordis 下只注册了 ${registered.size} 个工具`);

    const noFsSave = await registered.get('report_save').execute({ report: 'cordis无fs', items: [{ key: 'a' }] }, {});
    if (noFsSave?.snapshot?.index === 1) pass('没有 fs 服务时 report_save 照常工作');
    else fail('没有 fs 服务时 report_save 失败');

    class FsService extends Service {
      constructor(ctx) {
        super(ctx, 'fs');
      }
      async resolve(path, options) {
        return {
          targetKey: isAbsolute(path) ? path : join(options?.cwd ?? process.cwd(), path),
          displayPath: path,
        };
      }
      async readText(target) {
        return readFile(String(target.targetKey), 'utf8');
      }
      async writeText(target, content) {
        await writeFile(String(target.targetKey), content, 'utf8');
        return { version: 'check-1' };
      }
    }

    const fsFiber = root.plugin((ctx) => {
      new FsService(ctx);
    });
    await fsFiber;
    // 作用域 inject 在依赖就绪后的下一个微/宏任务里回调，给它一拍。
    await new Promise((resolve) => setTimeout(resolve, 100));

    const bodyFile = join(cordisTemp, '正文.md');
    await writeFile(bodyFile, '# 真实 cordis 下的正文', 'utf8');
    const withFs = await registered.get('report_save').execute({ report: 'cordis有fs', bodyPath: bodyFile, items: [{ key: 'b' }] }, {});
    if (withFs?.snapshot?.bodyChars > 0) pass('fs 服务后注册后，作用域 inject 生效，bodyPath 可读');
    else fail('fs 注册后 bodyPath 仍然不可用');

    await fsFiber.dispose();
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (fiber.state === 2) pass('fs 服务被卸载后，插件 fiber 仍是 ACTIVE');
    else fail(`fs 卸载后插件 fiber 变成 ${FIBER_STATE[fiber.state]}`);
    try {
      await registered.get('report_save').execute({ report: 'cordis有fs', bodyPath: bodyFile }, {});
      fail('fs 卸载后 bodyPath 仍然可用 —— 说明还握着已处置的服务引用');
    } catch (error) {
      if (/fs 服务/.test(error.message)) pass('fs 卸载后引用被清理，回到可读报错');
      else fail(`fs 卸载后的报错不清楚：${error.message}`);
    }

    await fiber.dispose();
    await toolsFiber.dispose();
  } finally {
    await rm(cordisTemp, { recursive: true, force: true }).catch(() => {});
  }
} catch (error) {
  skip(`真 cordis 不可用（${error.code ?? error.message.split('\n')[0]}），只跑了替身装配检查`);
}

console.log(
  failures === 0
    ? `\n结果：全部通过${skipped > 0 ? `（${skipped} 项因缺少依赖跳过）` : ''}`
    : `\n结果：${failures} 项失败`,
);
process.exit(failures === 0 ? 0 : 1);
