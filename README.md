<img src="skill/assets/viewer/app-icon.svg" width="96" alt="动作台 MotionStage">

# 动作台 MotionStage

**3D 模型与动画工作台 · 3D model & animation studio**

在本机浏览器里看 3D 角色动作，停在某一刻，点一下身体部位，用一句话说出想怎么改；
动作台把这句话连同当时的时刻、镜头、截图和模型版本打包成一条任务，交给你正在用的 AI Agent。
Agent 回传候选后，原版和候选并排放在同一时刻、同一镜头下比较，由你决定留不留。原版始终保留。

打开游戏项目，左边是每个角色的头像，右边是这个角色能做的全部动作：每个动作都是一张渲染在**这个角色身上**的缩略图，
项目里骨架兼容的其他动作会被自动匹配过来。点一下卡片，角色就在舞台上做这个动作。

> A local, browser-based studio for reviewing 3D character animation with an AI agent:
> pause, point at a body part, describe the change in one sentence, hand the frozen task
> to your agent (CLI or stdio MCP), then compare the returned candidate side by side.
> The UI is in Chinese. MIT licensed. Skill / package id: `motion-stage`.

当前版本 4.4.0。界面只有中文。

## 4.2 工作流更新

- **游戏状态**默认在动作台离线预览项目提供的动作、外观和装备挂点。需要检查布料等运行时效果时，可在主视窗切换到「游戏角色」，直接预览当前动作。声明了预览入口并通过本机登记的项目，动作台会按需启动服务并自动读取状态。 [游戏状态接入](skill/references/runtime-preview.md)
- 自动扫描本机后台执行器，支持选择 Codex CLI、Claude Code 或 DeepSeek Harness；应用已安装但未接入时明确显示不可选，失败不切换客户端。

- 默认跟随调用 skill 的客户端和会话；任务冻结处理来源，跨客户端不会误领，补充和重试保留归属。无会话唤醒接口时显示等待领取，通过复制任务或 CLI/MCP 交接。
- 明确区分当前对话与本机自动处理，任务交接可直接复制；认可版本可通过独立的“接入游戏…”入口继续。
- 返回上一动作、结束试播和保留草稿各有明确入口；排队时取消，运行时停止。
- 采用、不用候选、加入或移出常用均可撤销与重做；记录随工作区保存，重做复用资产，不重新生成。
- 草稿保存到工作区，跨端口恢复、随项目迁移，多窗口冲突由你决定。
- 修改前在左、修改后在右；提交与评审按钮固定可见，手机布局提供预览、动作、任务、记录导航。
- 运动检查绑定本轮冻结输入，区分新增、加重、改善和未验证；展示时间位置及前后数值。
- 修复重复内容版本 A → B → A 的任务继承判断，保留每一轮独立身份。

## 适合谁

- 用 AI Agent 做游戏或动画的个人开发者：想把“这里不对”准确地告诉 Agent，而不是在聊天里反复描述。
- 手里有 GLB / FBX 角色和动作，想让每一轮修改都有记录：改了什么、谁改的、你否决过什么、哪一版被认可。
- 想让 Agent 改动作前先看到项目里相关的代码、制作源和你以前说过的话。

不适合：视频剪辑；代替 Blender / Maya 做完整的动画制作；自动重定向或布料求解。

## 快速试用（不需要自己的模型，也不需要 API Key）

需要 [Node.js 22+](https://nodejs.org/) 和支持 WebGL2 的浏览器。不需要 `npm install`：
查看器、Three.js 和解码器都已随包提供。

```sh
git clone https://github.com/jbang2004/motion-stage.git
cd motion-stage/skill
node scripts/start.mjs
```

也可以直接双击：macOS 用 `skill/Open MotionStage.command`，Windows 用
`skill/Open MotionStage.cmd`。

第一次启动会在用户目录下建一个 `motion-stage-workspace` 练习工作区，载入一个**原创的分段练习人偶**
（两段动作：Run、Salute），自动选空闲端口并打开浏览器。保持终端窗口开着，`Ctrl+C` 停止。
不要直接双击 `index.html`。

三步上手：

1. **找到那个瞬间**：在“动作库”点一张动作卡片，切到“修改”，放慢、按空格暂停；可以点一下身体定位部位。
2. **说出想要的变化**：例如“左手摆得太大，收一点，另一只手和脚步保持”。
3. **用同一个镜头看结果**：候选回来后自动并排对照，可逐帧比较、保留原版或继续提意见。

不连接任何 AI 也能体验一轮：页面里的“先试一次本地微调”是一个确定性的摆幅缩放工具，
用来熟悉流程；它不是 AI 修改，页面也不会把它说成 AI 修改。

## 动作库：选角色，点动作

1. **选角色**：左侧角色栏是项目里声明的角色，头像直接渲染自角色模型；“全部角色”还能看到项目里其他带蒙皮的模型。
2. **看动作**：右侧按“常用 / 角色自带 / 匹配动作”分组，每张卡片是角色在这个动作关键姿势上的样子（行走取迈步、跳跃取最高点、攻击带残影）。
   顶部分类：全部、待机、移动、攻击、技能、防御、受击、跳跃、倒地、表演、其他（根据动作名推断，仅供参考）；搜索支持中文名、英文名和原始动作名。
3. **点一下就播放**：角色自带的动作立刻播放；匹配动作是临时试播，不改模型，镜头会自动框住整段动作。鼠标悬停在卡片上可以先看小预览。
4. **想改就点“修改这个动作”**：切到修改模式，接着暂停、点部位、写一句话。

“匹配动作”来自后台扫描：项目里其他 GLB 和已转换动作，只要参考姿势和骨骼层级与当前角色一致就会列出，完全相同的曲线自动去重。
扫描期间可以照常播放已有动作。缩略图保存在工作区 `cache/thumbnails/`，删掉也会自动重新生成。

“版本与来源”是管理入口；“项目文件”保留动作包、制作源、旧模型和构建副本，其文件数量不等于角色数量。不兼容或尚未转换的动作需要先适配或导入，不会冒充可直接播放的动作。

详见 [动作库](skill/references/action-library.md) 和 [分离动作与版本设计](skill/references/separated-motion.md)。

## 连续修改与审阅

- 同一模型同时保留一条排队、执行中或等待补充的任务；其他模型可以排队。重复提交时保留草稿，先完成、补充或取消已有任务。
- 对照恢复该轮实际输入的时间、镜头、播放速度、根运动锁定和对齐方式。两版共用输入的尺度与原点，避免把候选尺寸变化自动缩放掉；可切换原始尺度检查。
- 执行中断后保留每次执行的独立输出目录。检查已有产物后可明确重试；源版本变化时需重新提交，不会自动重放旧意见。
- 评审可补充未采用的原因。已认可检查点可显式恢复为当前候选，正式游戏文件仍需单独接入。
- 历史分页加载，后台轮询只同步摘要和变化。暂停且没有动态外观时停止连续绘制。

## 导入自己的角色

- **自包含 GLB**（带或不带动画）：直接导入，支持 Meshopt、Draco、KTX2 压缩。
- **FBX**：需要本机装 [Blender 4.2+](https://www.blender.org/download/)（可选）。动作台会自动寻找 Blender，
  也可以设置环境变量 `BLENDER_EXECUTABLE`。转换时保留原文件、可编辑的 `.blend` 和时间映射。
- **只有骨架的动作 FBX**：单独无法显示角色变形；请下载同一角色的 With Skin 版本，或交给 Agent 做重定向。
- **关联游戏项目**：顶栏“关联项目”选一次工程文件夹，素材、任务和决定都保存在该项目的
  `.motion-studio/` 里，下次自动恢复。关联不会改动正式游戏文件。

```sh
node scripts/start.mjs --project "/absolute/path/to/your/game"
```

格式、迁移和排错见 [skill/references/setup.md](skill/references/setup.md)。

## 让 AI Agent 接手任务

在页面上提交的修改要求会变成一条**冻结的任务**：源文件 SHA、动作、时刻、镜头、选区、截图和项目上下文
都固定下来。Agent 可以用三种方式接手：

**1. 当前对话里的 Agent，用命令行。** 任何能运行 shell 命令的 Agent 都可以：

```sh
node scripts/motion-feedback.mjs jobs     --workspace "$WORKSPACE"
node scripts/motion-feedback.mjs claim    --workspace "$WORKSPACE" --job "$ID" --owner my-agent
node scripts/motion-feedback.mjs progress --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --phase editing --message "正在收小左上臂摆幅"
node scripts/motion-feedback.mjs complete --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --candidate candidate.glb --summary "改了什么、查了什么"
```

想先知道某个角色能做哪些动作，Agent 可以直接列出动作库（只读，带分类和中文名）：

```sh
node scripts/motion-feedback.mjs actions --workspace "$WORKSPACE" --category attack
```

**2. stdio MCP。** 提供任务、执行恢复、检查点恢复、资产检查和动作库（`motion_action_catalog`）工具：

```sh
node scripts/mcp.mjs --workspace "$WORKSPACE"
```

**3. 可选的 Codex 后台 worker。** 如果本机装了并登录了 [Codex CLI](https://github.com/openai/codex)，
页面默认“当前对话处理”：保存后复制给当前 Agent。选择“本机 Codex 自动处理”再提交会启动后台 worker 自动处理对应任务，使用你账号的正常额度，
不需要另外的密钥。注意：这个按钮一次点击就会连接并开始执行；只想排队时点“只保存任务，稍后处理”。

也可以把整个 `skill/` 文件夹装成 Agent 的 Skill（目标目录不能已存在）：

```sh
node scripts/motion-feedback.mjs install --target "$HOME/.claude/skills/motion-stage"   # Claude Code
node scripts/motion-feedback.mjs install --target "$HOME/.codex/skills/motion-stage"    # Codex
```

Agent 的使用说明在 [skill/SKILL.md](skill/SKILL.md) 和
[skill/references/agent-workflow.md](skill/references/agent-workflow.md)。

**实际测过哪些 Agent**（详细记录见 [skill/references/agent-case.md](skill/references/agent-case.md)）：

| Agent | 方式 | 结果 |
|---|---|---|
| Codex CLI | 页面里的后台 worker | 2026-11-03 在一个 65 骨骼的游戏角色上完成往返 |
| Claude Code | 当前对话 + CLI | 2026-11-05 在练习人偶上完成往返（领取 → 修改 → 检查 → 回传 → 并排对照） |
| 任意 MCP 客户端 | stdio MCP | 只用原始 JSON-RPC 测过握手、工具列表和读任务；还没有在某个 Agent 里完整走一遍 |

其他 Agent 用同一套 CLI / MCP 约定理论上可用，但没有测过。

## 诚实的局限

- **AI 改得好不好取决于你用的 Agent 和模型。** 动作台只负责把上下文说清楚、把版本管住、把检查记下来，
  它自己不会“智能修动作”。
- **预览不是游戏。** 三维预览是中性的 Three.js 渲染，不复现游戏里的着色器、实时布料、引擎 IK、
  战斗混合或根运动控制器。正式效果仍要在游戏里看。
- **本地微调只能做一件事**：对一个明确的骨骼、在 LINEAR 四元数旋转轨道上缩放摆幅。遇到 STEP、
  CUBICSPLINE 或压缩轨道会拒绝，不会硬改。
- **不同骨架不能靠格式转换自动匹配。** 静态角色配另一套动作需要真正的重定向和制作源。
- **数值检查不等于好看。** 采样检查只证明检查范围内的数据没被破坏，不证明动作自然、没有穿插；
  采不采用永远由你决定，动作台不会替你“自动认可”。
- **平台验证有限。** 完整的三系统（macOS / Windows / Linux）× Node 22 / 24 / 26 矩阵最后一次在
  2.4.2 版本上跑通；本次 3.1.0 在 macOS 上进行回归验证，新的完整跨平台结果需由 CI 确认。`.github/workflows/portable-release.yml`
  是现成的 CI，仓库公开后每次提交都会重跑。
- **只有中文界面**，目前由一个人维护。
- 程序只监听 `127.0.0.1`，模型和历史都留在本机。但连接在线 Agent 后，你的要求、选区和截图会进入
  该 Agent 的模型上下文。

## 目录

- `skill/`：完整的工具源码，也就是可安装的 Skill。打包只读取这个目录。
- `tools/package-skill.py`：从 `skill/` 生成发行 ZIP、`bundle-manifest.json` 和 `release.json`。
- `tools/ci/`、`.github/`：跨平台 CI、真实 Blender 和浏览器验收脚本；公开测试素材来自 Khronos glTF
  Sample Assets，按提交号和 SHA 锁定，见 [tools/ci/real-assets/README.md](tools/ci/real-assets/README.md)。
- `tools/diagnostics/`：一次性排障探针，不属于常规验收。

## 开发

在仓库根目录：

```sh
node --test skill/scripts/test/*.test.mjs
python3 tools/package-skill.py
```

修改代码时沿现有职责边界：`workspace-store.mjs` 统一负责锁与事务；`model-catalog.mjs` 负责目录
查询和展示；`project-context-view.mjs` 只投影项目资料；`app.js` 协调模型、视图和任务。版本号统一来自
`skill/package.json`。CI 的命令和覆盖范围见 [tools/ci/README.md](tools/ci/README.md)。

## 许可与第三方

- 本仓库的代码、文档、模板和原创练习人偶及其动作：[MIT](skill/LICENSE)。
- 随包的第三方运行时保留各自许可，见 [skill/THIRD_PARTY.md](skill/THIRD_PARTY.md) 和
  `skill/assets/vendor/licenses/`：Three.js r186（MIT）、Draco 解码器（Apache-2.0）、
  Basis Universal 转码器（Apache-2.0）、meshoptimizer 解码器（MIT）、ktx-parse（MIT）、
  zstddec（MIT，内含 Zstandard 的 BSD 声明）。
- 不包含任何游戏角色模型、购买的动作包、在线字体、遥测或云端 API 客户端。
- `skill/assets/case/` 和 `skill/references/real-case.md` 是一次真实修改的**文字记录**（无截图、无模型、
  无动作数据），出自作者自己的同人游戏；其中提到的角色名只作历史记录，权利属于原作者。

## 来历

动作台是作者用 AI 在大约一个月里做一个同人 Three.js 动作游戏时顺手长出来的。
做角色动作时，最难的不是让 AI 动手改，而是让它知道“改哪一刻、哪里不对、哪些不能动、上一轮被我否决过什么”。
于是先在游戏里搭了一个专门看动作的页面，后来把它从游戏里拆出来，去掉所有游戏素材，就成了现在的动作台。

一次真实的“否决改编、退回原版”的过程，记录在 [skill/references/real-case.md](skill/references/real-case.md)。

视频：B 站视频即将发布

游戏本身和其中的角色素材不开源。
