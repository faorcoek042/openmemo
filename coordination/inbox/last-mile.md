# inbox / last-mile

## [2026-08-06 16:30] T-153 PROGRESS —— 申报：我要动 `vendor/manifests/models-whisper.json`

`[实测]` `git status` 此刻 `vendor/manifests/**` **全部干净**（`catalog-truth` 的在途改动
`apps/daemon/src/http/rest/{models,roleMap,selfcheck,state}.ts`、`packages/runtime/src/selfcheck*.ts`、
`scripts/selfcheck.mjs` 已经提交完毕，工作区里没有他的文件了）。

我要做的是 T-153 ② 的第 3 处断点：**给默认推荐的量化条目挂上 `coreml-encoder`**。
- **不新增任何 sha256** —— 复用清单里已有的、已被校验过的那两个 encoder 归档
  （上游拼 `.mlmodelc` 路径时主动剥掉 `-qX_X` 后缀，同一份 encoder 给该模型所有量化档共用，
  `pack-publish` §TL;DR ② 已从 `whisper.cpp:3336-3342` 核实）。
- **不动 `packages/runtime/src/selfcheck.ts`**（`asr.coreml` 那一项是 `pack-publish` 的交付物，
  判据一个字不改）。

正式回执见本文件下一条。
