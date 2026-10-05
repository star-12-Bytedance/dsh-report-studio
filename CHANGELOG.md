# Changelog

本文件记录本插件的所有重要变更。
格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] - 2026-10-05

### Added

- 首个版本：把报告从「一次性文档」变成「可追加、可对比的活视图」。
- `report_save` —— 把一次运行的结果追加为某命名报告的新快照（结构化条目 + 可选 Markdown
  正文），并立刻返回与上一快照的差异摘要。
- `report_diff` —— 对同一报告的两个快照做结构化比对，输出新增 / 消失 / 变化三个分区，
  变化精确到字段（`severity: high → critical`、`status: open → fixed`）。
- `report_list` —— 列出所有报告、各自快照数与最近时间；指定报告时给出完整快照时间线。
- `report_render` —— 把某个快照渲染成完整 Markdown（表头、本次变更、全部条目表、正文），
  可直接返回给模型，也可通过 fs 服务写入用户指定路径。
- 稳定标识配对：`key → id → title → name → 内容哈希`，条目数组顺序变化不产生假 diff；
  缺少稳定标识时在 `warnings` 中明确警告「内容变化会被同时算作新增 + 消失」。
- 快照写入原子化：同目录临时文件 → `fsync` → `rename`，并对 Windows 上
  `EPERM/EACCES/EBUSY` 做退避重试；自测断言不残留 `.tmp-` 文件。
- 索引自愈：目录列表是真相、`report.json` 是缓存；孤儿快照（写完快照后崩溃）照样出现，
  索引损坏时从目录重建。
- 并发写入串行化：同一报告上的多个 `report_save` 通过 per-report 锁排队，索引不重复、不撕裂。
- `maxSnapshots` 可选剪枝，只删最旧的快照文件。
- 状态固定写在 `~/.dsh/report-studio/`，**不写工作区**（工作区常在云盘里，会造成同步 churn）。
- 文件系统能力作为**可选**依赖：`inject: ['tools']` + `ctx.inject(['fs'], …)`，
  没有 fs 后端时四个工具依然全部可用，只有 `bodyPath` / `writePath` 给出可读提示。
  写入前经过部署的 `fs/write-intent` 瀑布，不绕过「先读后写」策略。
- `scripts/check.mjs` 契约自检：静态检查零依赖（CI 可跑），装配与端到端检查在能解析
  `@deepseek-ai/*` 时执行，覆盖导出形态、打包契约、参数 DSL、输出 schema、无损 JSON、
  空态 render、快照往返、顺序无关、原子写残留、可选依赖两条分支。
- 纯 ESM，零运行时依赖。

[Unreleased]: https://github.com/star-12-Bytedance/dsh-report-studio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/star-12-Bytedance/dsh-report-studio/releases/tag/v0.1.0
