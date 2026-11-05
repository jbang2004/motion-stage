# 动作台 MotionStage 3.0.1

3D 模型与动画工作台 · 3D model & animation studio

从观察、提出修改，到查看 Agent 的真实进展，再把候选放回同一时刻与镜头下比较。每一步只显示当前需要的操作。

3.0 改名为「动作台 MotionStage」：Skill、包和安装目录标识改为 motion-stage，双击启动器改为 `Open MotionStage`，默认练习工作区改为用户目录下的 motion-stage-workspace（已有的 motion-feedback-workspace 继续使用）。数据格式不变，旧工作区和项目里的 `.motion-studio/` 直接沿用。

2.8 完善宽扁模型构图、重名骨架节点定位和 KHR Meshopt 读取，修复 FBX 非活动 Take 丢失及原生动作保存。按资源能力支持独立模型、骨架/节点动作和采样曲线预览；保留可选项目外观与中性检查模式。角色资源库按项目声明关联模型内、分离 GLB 与采样动作包。外部动作保留来源并检查兼容性，失败来源不会阻塞可用角色；文件列表仍可检查未归属资源。

```sh
node scripts/start.mjs
# 已明确游戏项目时
node scripts/start.mjs --project "/absolute/path/game"
```

需要 Node.js 22+；三维预览需要 WebGL2 浏览器，纯曲线可用 Canvas2D。macOS 可双击 `Open MotionStage.command`，Windows 可双击 `Open MotionStage.cmd`。内置原创练习角色，首次体验无需自己的模型、npm 安装或 API Key。

- **关联项目一次**：选择工程后在项目内 `.motion-studio/` 保存素材、任务、上下文修订、决定与验收检查点；下次恢复最近项目。
- **按任务带上下文**：自动查找相关代码、制作源与历史原话，逐项记录依据；连续修改按真实父版本继承，不把旧目标再做一遍。
- **导入素材**：支持自包含 GLB、静态角色；有本机 Blender 时可导入带角色的 FBX。
- **观察与表达**：单独、并排、叠影；逐帧、慢放、部位定位、时间范围、四视图；一句话提交修改要求。
- **真实 Agent 任务**：在现有聊天中通过 CLI/MCP 领取，或明确连接已登录的本机 Codex CLI 自动处理。后者使用账号正常额度，不要求额外密钥。
- **看得懂的进度**：真实阶段、最近活动、已用时间和最后更新时间；需要补充时直接回复继续，没有虚构百分比。
- **独立候选**：任务绑定资产版本，结果过期时拒绝覆盖新工作；保留执行记录与用户决定。
- **本地动作微调**：显式选骨骼和摆动系数即可试用确定性变换；此工具不冒充 AI 创作或自动艺术验收。

安装、导入格式、连接与排错见 [运行说明](references/setup.md)。Agent 使用入口为 [SKILL.md](SKILL.md)，任务操作见 [Agent 工作流程](references/agent-workflow.md)。

静态角色与另一套动作骨架不能仅靠格式转换自动匹配。复杂重定向、衣料和游戏运行时仍需实际制作源与对应工具。代码和原创练习资源见 LICENSE，第三方库见 THIRD_PARTY.md，历史案例见 references/real-case.md。包中不包含私人游戏角色或商用动作。

验证：`node --test scripts/test/*.test.mjs`。

项目工作区、来源关联与连续修改规则见 [项目上下文说明](references/project-workspace.md)。

通用资源预览支持独立模型、骨架/节点动作和采样动作 JSON；纯曲线不需要 WebGL2。模型与动作组合仍需明确关联和兼容检查，旧版本与任务记录继续保留。详见 [资源库](references/asset-library.md)。
