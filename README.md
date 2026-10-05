# dsh-report-studio

> DeepSeek Harness (DSH) 插件的**实时报告工作台**。
> 报告不是一次性文档，而是**活的视图**：同一个目标今天跑一次、明天再跑一次，
> 你要的不是两份互不相干的文档，而是**这一版比上一版多了什么**。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/DSH-plugin-blue)](https://github.com/deepseek-ai/deepseek-harness)

---

## 它解决什么问题

渗透 / SRC / 比赛 WP / 题解 / 实验报告几乎都是**一次性产物**：跑一次扫描，写一份 Markdown，
下次再跑，再写一份。于是每个真实问题都答不上来：

- 上次扫出来的 12 个洞，这次**修好了几个**？**新冒出来几个**？
- 那个中危洞，这周**升级成高危**了吗？
- 我到底是**第几次**跑这个目标了？**上一次**是什么时候？
- 这两份文档之间的差异，除了肉眼比对，还有别的办法吗？

静态 Markdown 没有「身份」的概念——文件写下去那一刻，它和上一版的关系就断了。

`dsh-report-studio` 把报告变成一个**有名字、可追加的容器**：每次运行往同一个报告里
追加一个带时间戳的**快照**，然后立刻和上一个快照做**结构化比对**。差异不是靠人眼找的，
是插件算出来的。

## 真实示例

下面全部是端到端自测的**真实输出**（一次 `edusrc报告` 的两次扫描）。自测把状态目录指到
系统临时目录，所以示例里的路径是临时路径——默认状态目录是 `~/.dsh/report-studio/`。

**第一次扫描，建立基线：**

```
已保存快照 #1「第一次扫描」 → edusrc报告 · 2026/10/5 21:28:01
条目 5（有稳定标识 5 · 依赖内容哈希 0）
文件：20261005T132801025Z--d17df7fb.json
这是该报告的第一个快照，没有基线可比较——全部条目都算新增。
新增 5 条。
```

**第二天复测，同一个报告名，追加第二个快照——差异当场算出来：**

```
已保存快照 #2「第二次扫描」 → edusrc报告 · 2026/10/5 21:28:01
条目 5（有稳定标识 5 · 依赖内容哈希 0） · 正文 50 字符
文件：20261005T132801065Z--a1d81bb8.json
与上一快照 #1（2026/10/5 21:28:01）相比：新增 1 · 消失 1 · 变化 2 · 未变 2
  + 任意文件上传（新）
  - Redis 未授权访问
```

**单独问「和上次比有什么变化」：**

```
报告：edusrc报告（共 2 个快照，目录 C:\...\state\reports\edusrc报告）
对比：#1 2026/10/5 21:28:01「第一次扫描」 → #2 2026/10/5 21:28:01「第二次扫描」
新增 1 · 消失 1 · 变化 2 · 未变 2

新增（1）：
  + 任意文件上传（新）

消失（1）：
  - Redis 未授权访问

变化（2）：
  ~ 登录接口 SQL 注入
      detail: username 参数可用报错注入 → username 参数可用报错注入，已能 dump users 表
      severity: high → critical
      tags: ["sqli"] → ["sqli","confirmed"]
  ~ 越权查询他人成绩
      status: open → fixed
```

注意最后两行：**`severity: high → critical`** 和 **`status: open → fixed`**。
这正是静态文档表达不了、而实际工作里最想知道的东西。

模型拿到的不是这坨文本，是**结构化结果**（同一份数据的 JSON 视图，节选）：

```json
{
  "baseline": "auto",
  "counts": { "added": 1, "removed": 1, "changed": 2, "unchanged": 2, "baseTotal": 5, "headTotal": 5 },
  "added":   [{ "identity": "key:https://jw.example.edu.cn/upload", "title": "任意文件上传（新）", "stable": true }],
  "removed": [{ "identity": "key:10.10.3.7:6379", "title": "Redis 未授权访问" }],
  "changed": [
    { "identity": "key:https://jw.example.edu.cn/login",
      "fields": [
        { "field": "detail",   "from": "username 参数可用报错注入", "to": "username 参数可用报错注入，已能 dump users 表" },
        { "field": "severity", "from": "high", "to": "critical" },
        { "field": "tags",     "from": "[\"sqli\"]", "to": "[\"sqli\",\"confirmed\"]" }
      ] },
    { "identity": "key:https://jw.example.edu.cn/api/score",
      "fields": [{ "field": "status", "from": "open", "to": "fixed" }] }
  ],
  "limits": { "limit": 50, "truncated": false },
  "warnings": []
}
```

**渲染成一份可以交出去的 Markdown**（`report_render` 写盘后的真实文件内容，节选）：

```markdown
# edusrc报告

> 快照 `04ca037e` · #2 · 2026/10/5 21:28:01 · `2026-10-05T13:28:01.065Z` · 标签：第二次扫描 · 来源：nuclei + 手工验证
>
> 报告目录：`C:\...\state\reports\edusrc报告`

## 本次变更

基线：快照 `2e5f1b86`（#1 · 2026/10/5 21:28:01）

**新增 1 · 消失 1 · 变化 2 · 未变 2**（当前共 5 条）

### 新增

- **任意文件上传（新）** — `key:https://jw.example.edu.cn/upload`

### 消失

- ~~Redis 未授权访问~~ — `key:10.10.3.7:6379`

### 变化

- **登录接口 SQL 注入** — `key:https://jw.example.edu.cn/login`
  - `detail`: username 参数可用报错注入 → username 参数可用报错注入，已能 dump users 表
  - `severity`: high → critical
  - `tags`: ["sqli"] → ["sqli","confirmed"]
- **越权查询他人成绩** — `key:https://jw.example.edu.cn/api/score`
  - `status`: open → fixed
```

**空态**也有明确文案，不会给你一段空白：

```
$ report_diff({ report: "尚不存在的报告" })
没有找到报告「尚不存在的报告」的任何快照。
查找位置：C:\...\state\reports\尚不存在的报告
可能名字拼错了，或者还没有用 report_save 存过。用 report_list 看看已有哪些报告。

$ report_list({ report: "打错的名字" })
没有找到报告「打错的名字」。状态目录：C:\...\state\reports
已存在的报告（1 个）：单快照报告

$ report_diff({ report: "只有一个快照的报告" })
报告：单快照报告（共 1 个快照，目录 C:\...\state\reports\单快照报告）
目标快照 #1 2026/10/5 21:28:52「唯一一次」 — 这是最早的一个快照，没有基线。
全部 5 条都计为新增。
新增 5 · 消失 0 · 变化 0 · 未变 0

$ report_save({ report: "单快照报告", items: [...和上次完全一样...] })
与上一快照 #1（2026/10/5 21:28:52）相比：新增 0 · 消失 0 · 变化 0 · 未变 5
与上次完全一致，没有新增、没有消失、没有变化。
```

**没有稳定标识会怎样？** 这是插件唯一会产生假 diff 的情况，它不藏：

```
$ report_save({ report: "无key报告", items: [{ target: "a.example.com", severity: "low" }, ...] })
$ report_save({ report: "无key报告", items: [{ target: "a.example.com", severity: "medium" }, ...] })  # 只改了 severity
$ report_diff({ report: "无key报告" })
新增 1 · 消失 1 · 变化 0 · 未变 1

新增（1）：
  + a.example.com

消失（1）：
  - a.example.com
注意：2 条当前条目没有可用的稳定标识（key/id/title/name），按内容哈希配对：内容一改就会同时算作「新增」和「消失」。这不是真实变化，但插件无法区分。
```

同一个条目同时出现在「新增」和「消失」里，就是缺 `key` 的信号——加上 `key` 之后，
它会正确地落进「变化」。插件宁可把这件事说出来，也不假装 diff 是对的。

## 功能

| 能力 | 说明 |
| --- | --- |
| 命名报告 | `report` 是一个稳定的名字（`edusrc报告`、`校赛WP`、`物理实验-示波器`），名字即身份 |
| 时间戳快照 | 每次运行追加一个快照文件，永不覆盖历史 |
| 基线 diff | 按**稳定标识**配对，输出新增 / 消失 / 变化三个分区，变化精确到字段 |
| 字段级变化 | `severity: high → critical`、`status: open → fixed` 这种直接给出前后值 |
| 顺序无关 | 条目的数组顺序变了不算变化——比对按标识，不按下标 |
| 报告渲染 | 一键渲染成完整 Markdown（表头、变更章节、全部条目表、正文），可写入指定路径 |
| 本地状态 | 只写 `~/.dsh/report-studio/`，**绝不写工作区**（工作区常在 OneDrive 里，会同步 churn） |
| 原子写入 | 临时文件 → fsync → rename；索引损坏或落后都能从目录自愈 |
| 零运行时依赖 | 纯 ESM，peer 依赖由 DSH 提供 |

## 安装

```bash
dsh plugin --profile <你的profile> add @star-12-bytedance/dsh-report-studio
```

或从本地目录安装（开发用）：

```bash
dsh plugin --profile <你的profile> add /absolute/path/to/dsh-report-studio
```

装完**先核对配置层再启动**，否则容易把「没挂载」误判成「插件有 bug」：

```bash
dsh --profile <你的profile> --dump-config   # 确认能看到 report-studio 这一行
dsh --profile <你的profile>
```

## 使用

四个工具，模型可以直接调用：

| 工具 | 作用 | 关键参数 |
| --- | --- | --- |
| `report_save` | 把这次结果追加为某报告的新快照，并立刻给出与上一快照的差异 | `report`（必填）、`items`、`body`、`bodyPath`、`label`、`source` |
| `report_diff` | 比较同一报告的两个快照 | `report`（必填）、`from`、`to`、`limit`、`detail` |
| `report_list` | 有哪些报告、各多少快照、最近一次什么时候；给 `report` 就列出该报告的时间线 | `report`、`limit` |
| `report_render` | 把某个快照渲染成完整 Markdown，可写入指定路径 | `report`（必填）、`snapshot`、`writePath` |

**`report_save` 的条目结构。** 每条是一个普通 JSON 对象，除下列字段外的任意字段都会被
完整保留并参与 diff（`additionalProperties: true`）：

```jsonc
{
  "key": "https://jw.example.edu.cn/login",  // 稳定标识，强烈建议给
  "title": "登录接口 SQL 注入",
  "severity": "high",                        // 严重度
  "target": "jw.example.edu.cn",             // 影响目标
  "status": "open",                          // open / fixed / verified ...
  "detail": "username 参数可用报错注入",
  "tags": ["sqli"],
  "任意你自己的字段": "都会保留"
}
```

**快照引用写法**（`from` / `to` / `snapshot` 通用）：

| 写法 | 含义 |
| --- | --- |
| `latest`（默认） | 最新一个快照 |
| `previous`（`from` 的默认） | 目标快照的前一个 |
| `#3` 或 `3` | 第 3 个（1 起）；`-1` 是最后一个 |
| `a1b81bb8` | 快照 id 或其唯一前缀 |
| `20261005T132801` | 文件名里的时间戳前缀 |

**典型对话：**

- 「用 report_save 把这次 nmap 结果存进 `edusrc报告`，每条带 key 和 severity」
- 「和上次比，这次新增了什么？」
- 「`edusrc报告` 我一共跑过几次？最近一次是什么时候？」
- 「把最新一版渲染成 Markdown，写到 `D:\交付\edusrc报告-20261005.md`」

## 状态目录

```
~/.dsh/report-studio/
└── reports/
    └── edusrc报告/                     ← 目录名 = 报告名的 slug
        ├── report.json                 ← 索引：名字、创建时间、快照列表
        └── snapshots/
            ├── 20261005T132801025Z--d17df7fb.json    ← 快照 #1
            └── 20261005T132801065Z--a1d81bb8.json    ← 快照 #2
```

- 快照文件名 = `UTC 时间戳 -- 随机 id`，**时间可以直接从文件名反解**，所以列表页不需要
  读文件正文；名字里的冒号被去掉是因为 Windows 不允许。
- 快照文件是完整自包含的 JSON（元信息 + `items` + 可选 `body`），单个文件即可离线复现。
- `report.json` 只是**索引与缓存**，不是真相：**目录列表才是真相**。索引丢了、坏了、
  落后了，插件都能从目录重建（见下面的「设计取舍」）。

## 设计取舍

**1. 为什么 diff 要「稳定标识」，而不是按下标。**

按下标配对是最容易写、也最容易产生**假 diff** 的做法：扫描器输出顺序一变，
12 个条目会全部显示成「消失 + 新增」。所以这里的配对键是：

```
key  →  id  →  title  →  name  →  内容哈希
```

用户给的 `key`（URL、CVE 号、题号、实验项）永远是最优解。**一条都没有**的条目退化成
内容哈希，此时内容一改就会被同时算成「新增」和「消失」——这是诚实的限制，不是 bug，
插件会在 `warnings` 里明确说明：

```
注意：2 条当前条目没有可用的稳定标识（key/id/title/name），按内容哈希配对：
内容一改就会同时算作「新增」和「消失」。这不是真实变化，但插件无法区分。
```

自测里有一条专门盯这个：把条目数组**倒过来**再存一次，`新增/消失/变化` 必须全是 0。

**2. 写入是原子的，索引损坏能自愈。**

半写的快照比没有快照更糟——它会污染之后**每一次** diff。所以每次写入都是
「同目录临时文件 → `fsync` → `rename`」，`rename` 在单目录内是原子操作；
Windows 上杀毒/索引器偶尔会短暂占用目标文件，这里对 `EPERM/EACCES/EBUSY` 做了退避重试。

快照文件与索引文件是**两次**独立的原子写，所以中间崩溃是可能的。这里的处理是：
**目录 = 真相，索引 = 缓存**。索引缺失的孤儿快照照样出现，索引缺的元信息从快照文件里补；
索引损坏就当作不存在并重建。自测里真的伪造了这两种状态：

```
⑩ 崩溃自愈：快照写好了但索引没写成
  索引存在? false
  目录里 1 个快照、索引缺失 → report_list 仍读到: 1 个（孤儿快照）
  再存一次后：与孤儿快照的差异: {"added":1,"removed":0,"changed":0,"unchanged":1,"headTotal":2}

⑪ 索引损坏 / 显式引用不存在
  report.json 损坏后 report_list 仍读到 2 个快照（索引从目录重建）
```

**3. 为什么状态不写工作区。**

工作区大多在 OneDrive / iCloud / 坚果云里。每次跑扫描都往工作区写一个快照文件 =
每次都触发一次云盘上传与同步冲突。所以状态固定在 `~/.dsh/report-studio/`，
和 `dsh-llm-profile` 把调用日志写进 `~/.dsh/llm-profile/` 是同一个理由。

**4. `fs` 是可选依赖，不是硬依赖。**

`inject: ['tools']` 是硬依赖；文件系统能力用 `ctx.inject(['fs'], …)` 单独接。
原因很实际：声明了 `inject` 而服务缺失时，cordis 的 fiber 会停在 PENDING，
**插件无声消失且不报错**。把 `fs` 写进 `inject` 会让「部署没挂载文件系统后端」直接
变成「报告工作台整个不存在」——而报告快照本身根本不需要 fs。

所以：

- 没有 `fs` → 四个工具全部可用，`body` 直接传字符串即可；只有 `bodyPath`/`writePath`
  会给出可读报错（自测里验证过这条提示）；
- 有 `fs` → `bodyPath` 从用户路径读正文，`writePath` 把渲染结果写出去，并且**照走部署的
  `fs/write-intent` 瀑布**，不绕过「先读后写」策略（自测里验证了瀑布确实被调用）。

**5. 条目是「开放的记录」。**

条目对象的 schema 是 `additionalProperties: true`：插件不预设你的字段长什么样，
你给的任何字段都会被保留、被 diff。只有输出 schema 是严格的——这是 DSH 运行时的要求，
输出里的任何 `undefined` 都会让整次工具调用失败（`snapshotToolValue` 只接受无损 JSON）。

## 配置

在 DSH 设置界面或 profile patch 里可改：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | `~/.dsh/report-studio` | 状态根目录。改成工作区会让每次快照都触发云盘同步 |
| `identityFields` | `["key","id","title","name"]` | 依次尝试作为稳定标识的字段名 |
| `diffLimit` | `50` | 每个分区最多返回多少条，防止大报告撑爆上下文 |
| `maxSnapshots` | `0`（不限制） | 单报告最多保留多少快照，超出剪掉最旧的（只删快照文件） |
| `maxBodyChars` | `200000` | 单快照正文上限，超出截断并在结果里标 `bodyTruncated` |
| `maxRenderChars` | `60000` | `report_render` 回给模型的 Markdown 上限；写文件时始终写完整正文 |

## 已知限制

- **内容哈希标识会产生假 diff**（同上，有 `warnings` 提示；给 `key` 即可消除）。
- **`maxSnapshots` 剪枝不可逆**：它真的删文件，删掉的历史只能靠备份找回。
- **不跨报告比对**：两个不同的报告名就是两份报告，哪怕内容相关。
- **同毫秒内的并发写入按 id 定序**：5 个 `report_save` 挤在同一毫秒里也能全部落盘、
  索引不重复（自测验证过），但这一毫秒内的「先后」是 id 决定的随机顺序。真实工作流
  不会在 1ms 内跑 5 次扫描。
- **`writePath` 可能被部署策略拦下**：目标文件已存在且本会话没读过它时，
  `fs/write-intent` 会返回 `createIfAbsent`，写入失败——插件会转成可读提示，
  建议改用带日期戳的新文件名。
- 条目必须是**无损 JSON**：这是 DSH 工具运行时的约束，不是本插件加的。

## 兼容性

- 需要 DSH 的 `tools` 服务（`inject: ['tools']`）；`fs` 服务可选。
- 在 DSH `0.2.0-rc.2` 上按实际源码核对过：`defineTool` 的参数 DSL、输出 schema 的严格
  校验与 `snapshotToolValue` 的无损 JSON 要求、`ctx.inject(deps, callback)` 的作用域注入、
  `fs/write-intent` 瀑布的调用形态。
- 纯 ESM，无运行时依赖（peer 依赖由 DSH 提供）。

## 开发

```bash
git clone https://github.com/star-12-Bytedance/dsh-report-studio.git
cd dsh-report-studio

# 插件里的裸导入（@deepseek-ai/*）由 DSH 提供。
# 本地开发时在插件目录建一个指向 DSH node_modules 的软链（不要提交）：
#   Windows:  cmd /c mklink /J node_modules "<DSH>/resources/app/dsh/node_modules"
#   macOS/Linux:  ln -s "<DSH>/resources/app/dsh/node_modules" node_modules

npm run check          # 契约自检 + 端到端往返（状态全部写在系统临时目录里）
npm run check:strict   # 依赖解析不到时直接失败，避免把「跳过」当成「通过」
npm run pack:check     # 检查将要发布的文件清单
```

`npm run check` 覆盖的都是 DSH 插件的**静默失败点**，每一条都对应一种「装好了但什么
都没做」：

1. `apply` / `inject` / `name` / `Config` 以**命名导出**暴露（`export default` 会被
   Loader 的 `unwrapExports` 折叠并静默丢掉 `inject`）；
2. 没有 `export default`（静态 + 运行时各查一遍）；
3. `package.json` 的 `dsh.bundle.patch` 存在、`files` 包含它、补丁里的挂载名与包名一致
   （漏了就是「装了不挂载」）；
4. 裸导入只在白名单里（多出来的就是隐藏的运行时依赖）；
5. 每个工具的参数规格能被 `defineTool` 规范化，输出 schema 非空；
6. **每个工具的真实返回值同时通过 `output.schema` 校验和无损 JSON 检查**——
   后者用 `@deepseek-ai/dsh-util-values` 同款的规则重实现，专抓 `undefined` 字段；
7. 空数据下 `execute` 与 `render` 不抛错，且 render 一定给出文案；
8. 端到端往返：快照 A → 快照 B → diff → render，断言 `新增 1 · 消失 1 · 变化 2 · 未变 2`、
   断言打乱条目顺序不产生假 diff、断言快照目录里没有残留的 `.tmp-` 文件；
9. 可选依赖：没有 `fs` 时报错可读，有 `fs` 时 `bodyPath`/`writePath` 真的读写文件。
10. **用 DSH 自带的真 cordis 再装配一遍**（不是替身 ctx）：`tools` 在、`fs` 不在时插件
    fiber 必须是 `ACTIVE`（写进 `inject` 就会停在 `PENDING` 然后无声消失）；`fs` 之后
    再注册时作用域 inject 才回调；`fs` 被卸载后插件仍 `ACTIVE` 且不再握着已处置的服务。

自测全部在系统临时目录里跑，结束即删；`~/.dsh/report-studio/` 不会被碰。

## License

[MIT](LICENSE) © 2026 star-12-Bytedance
