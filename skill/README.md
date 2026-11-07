<img src="assets/viewer/app-icon.svg" width="88" alt="动作台 MotionStage">

# 动作台 MotionStage 4.0.0

3D 角色动作工作台 · 3D character animation studio

打开游戏项目，就能看到每个角色能做的全部动作；一句话提出修改，由 Agent 真实执行，候选与原版放在同一时刻、同一镜头下对照。

- **动作库**：角色能播放的每个动作都是一张缩略图卡片，直接渲染在这个角色身上。项目里骨架兼容的动作会被自动找出来（参考姿势与层级一致，完全相同的曲线已去重），点一下就能播放。
- **一句话提修改，Agent 真实执行**：暂停、点一下身体部位、写一句话即可。任务交给当前聊天里的 Agent（CLI / MCP）或本机已登录的 Codex。进度显示真实阶段和最近活动，不编造百分比。
- **候选对照，原版始终保留**：候选回到提交时的时刻与镜头，可单独、并排或叠影比较。保留、继续调整还是退回原版，由你决定；正式游戏文件不会被改动。

## 快速开始

```sh
node scripts/start.mjs
# 已明确游戏项目时
node scripts/start.mjs --project "/absolute/path/game"
```

macOS 可双击 `Open MotionStage.command`，Windows 可双击 `Open MotionStage.cmd`。内置原创练习角色，第一次体验不需要自己的模型、npm 安装或 API Key。保持终端运行，Ctrl+C 停止。

## 运行要求

| 项目 | 说明 |
|---|---|
| Node.js 22+ | 必需 |
| 支持 WebGL2 的浏览器 | 三维预览需要；纯曲线预览可用 Canvas2D |
| Blender 4.2+ | 可选，用于导入 FBX |
| Codex CLI（已登录） | 可选，用于自动处理修改任务，使用你账号的正常额度 |

## 功能

- **关联项目一次**：在顶栏项目切换器选择游戏工程，素材、任务、决定和验收检查点都保存在项目内的 `.motion-studio/`；下次启动自动恢复。
- **角色栏**：项目角色以渲染好的头像列出；**全部角色** 还能看到项目里其他带蒙皮的模型。
- **动作库**：分为 **常用**、**角色自带**、**匹配动作**；按 待机 / 移动 / 攻击 / 技能 / 防御 / 受击 / 跳跃 / 倒地 / 表演 / 其他 分类（根据动作名推断，仅供参考），支持中文名、英文名和原始动作名搜索；悬停即看小预览。
- **试用别的动作**：匹配动作只是临时播放，不改模型；你明确收录后才进入 **常用**。
- **修改模式**：逐帧、慢放、部位定位、时间范围、四视图；在卡片上点 **修改这个动作** 就能开始。
- **看得懂的进度**：真实阶段、最近活动、已用时间；需要补充时直接回复一句话继续。
- **接入游戏**：保留的候选和收录的动作不会自动进游戏。回到对话说一句“接入游戏”，Agent 会列出等待接入的版本、改游戏文件、在游戏里检查并留下接入记录；结果卡片显示已接入的文件。
- **版本与来源**：公共动作包、名称映射和每个角色收录的动作分开管理，旧版本与任务记录全部保留。
- **导入素材**：**＋导入** 支持自包含 GLB、静态模型、采样动作 JSON；有本机 Blender 时可导入 FBX。
- **项目外观（可选）**：安装经审阅的适配包后，可用游戏自己的着色器预览角色；默认是中性检查。
- **环境检查**：**⋯ → 环境检查** 显示启动结果与浏览器的真实渲染状态。

## 从 3.x 升级

数据格式不变，项目里的 `.motion-studio/` 和独立工作区直接沿用。4.0 新增工作区 `cache/thumbnails/` 缩略图缓存，可以随时删除，下次查看时自动重新生成。升级前请先停止旧版服务。

## 边界

- 骨架不兼容的动作不能只靠格式转换套用，需要明确的重定向任务。
- 普通 GLB 不包含实时布料、引擎 IK、战斗混合或自定义材质；正式游戏效果仍需在游戏里检查。
- 程序只监听 127.0.0.1，模型与历史留在本机。连接在线 Agent 后，修改要求、选区信息和截图会进入该 Agent 的上下文。

## 文档

- Agent 入口：[SKILL.md](SKILL.md)
- 动作库：[references/action-library.md](references/action-library.md)
- 修改任务流程：[references/agent-workflow.md](references/agent-workflow.md)
- 分离动作与版本：[references/separated-motion.md](references/separated-motion.md)
- 接入游戏：[references/game-integration.md](references/game-integration.md)
- 角色声明：[references/character-map.md](references/character-map.md)
- 资源库与格式：[references/asset-library.md](references/asset-library.md)
- 项目工作区：[references/project-workspace.md](references/project-workspace.md)
- 项目外观：[references/project-appearance.md](references/project-appearance.md)
- 安装与排错：[references/setup.md](references/setup.md)
- 环境诊断与恢复：[references/reliability.md](references/reliability.md)
- 实测案例：[references/agent-case.md](references/agent-case.md)、[references/real-case.md](references/real-case.md)

## 测试与许可

```sh
node --test scripts/test/*.test.mjs
```

代码和原创练习资源见 [LICENSE](LICENSE)，第三方库见 [THIRD_PARTY.md](THIRD_PARTY.md)。包中不包含私人游戏角色或商用动作。
