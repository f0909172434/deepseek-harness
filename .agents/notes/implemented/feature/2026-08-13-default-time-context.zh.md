# Agent Note: 交付 profile 中的默认时间上下文

Status: implemented

[English](2026-08-13-default-time-context.md) | 中文

## 问题

每个交付 profile 中的模型都收不到当前时间。`@deepseek-ai/dsh-time-context` 已经存在且是持久的，但所有默认组合都把它留在禁用状态，因此该能力从未到达交付产品。依赖日期的推理——已观察到 web_search 查询年份这一案例——于是完全取决于模型的训练截止时间，模型可能为一个过时年份拼出搜索，而没有任何 harness 信号来纠正它。

## 决策

dsh-base 组合包以 id `time-context` 挂载该插件并设置 `refreshIntervalMs: 60000`，这是每个交付 profile（`web`、`headless` 以及基于 base 的自定义 profile）的第一层 patch。每个 Web 提示词仍以经 Host 校验的浏览器时区格式化读数；TUI、headless 及其他界面回退到进程时区，任何组合都可以按 id 禁用或重新配置这一行。

60 秒间隔是插件提供的两个极端之间、随发行版交付的平衡点：省略间隔会给每个合格且将进入步骤的步骤追加一条读数，让一次漫长的工具调用轮次堆满几乎相同的时钟重述；而一分钟前的读数仍然足以锁定日历日期推理。Schedule Web overlay 以按 id 的覆盖替换掉自己的 `insert` 并清空 base 配置，从而保持每一步的新鲜度——再插入一行相同 id 会因 loader 的重复 entry id 拒绝而在启动时失败——因此 overlay 仍是一个 patch 文件，没有重复行。

acp-snapshot 标准化器把持久读数的两个挂钟字段——渲染后的时间戳与经过时长——标记为 `{{timeReadingTimestamp}}` 与 `{{timeReadingElapsed}}`，轮次／步骤位置、浏览器时区策略和基线保持逐字不变，这样通过交付 profile 录制的 session fixture 可以在任何后续日期回放。

这逆转了 [持久 per-step time-context Agent Note](2026-07-16-durable-per-step-time-context.md) 中记录的 opt-in 立场，其机制保持不变。

## 考虑过的替代方案

- **不带刷新间隔挂载，如 Schedule overlay 原样**——作为通用默认被否决：每个合格步骤都会追加一条读数，一次漫长的工具调用轮次会累积数十条只重述时钟的消息。60 秒下限让日历推理保持新鲜，同时把历史增长和 Web 转录噪音限制在大约每轮一行上下文。需要每步新鲜度的组合可以清空间隔，Schedule 正是如此。
- **把当前日期加入系统提示词**——被否决：动态提示词值无法从 session 日志重建，会破坏「模型可见 ⟺ 已记录」不变量与历史请求重建；持久 per-step 读数则两者兼备。
- **在每个交付 agent preset 中挂载该行，而不是 host plane**——被否决：与 host plane 同时生效的 preset 行会被 plane-separation 门禁拒绝，而一行 host plane 行已经覆盖作用域链源自 host 根的所有 agent——包括加入 preset 的 Web 会话——逐 preset 复制只会增加冲突风险而没有覆盖收益。
- **保持 time-context 为 opt-in**——被否决：缺失就是交付默认，模型因而完全没有当前时钟，依赖日期的工具输入会悄然过时。本记录所记的正是这一逆转。

## 后果

- 每个交付 profile 现在会在没有读数、或最新读数至少已有一分钟时，于进入步骤之前告诉模型当前时间。
- Web 转录默认每轮显示一行上下文（来源 `time-context`，snapshot 形式）；Schedule overlay 保持每个请求步骤一行。
- Schedule Web overlay 现在是针对 base 行的按 id 配置覆盖，不再是 insert。
- 启动交付 profile 的 snapshot fixture 通过 acp-snapshot 标准化器标记 time-context 读数；产品 headless-profile fixture 端到端地实践了默认行。
