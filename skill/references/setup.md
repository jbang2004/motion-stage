# 安装与运行

## 打开

需要 Node.js 22+ 和支持 WebGL2 的浏览器（纯曲线预览用 Canvas2D，无 WebGL2 也可查看）。查看器、解码器和原创练习已随包提供，无需 npm install 或模型密钥。导入 FBX 另需本机 Blender 4.2+；自动处理任务可选已登录的 Codex CLI。

解压完整的 motion-stage 文件夹后，macOS 双击 `Open MotionStage.command`，Windows 双击 `Open MotionStage.cmd`。若系统不能直接打开脚本，在终端运行：

```sh
node scripts/start.mjs
```

启动器在用户目录的 motion-stage-workspace 创建首次练习，第二次继续原工作区；若已有改名前的 motion-feedback-workspace，则继续使用它。只在新工作区创建原创练习；自动选择空闲本机端口并打开浏览器（加 `--no-open` 只打印地址）；不要双击 index.html。保持终端运行，Ctrl+C 停止。指定其他工作区：

```sh
node scripts/start.mjs --workspace "/absolute/path/my-review"
```

Windows 可使用 `C:\Users\你的名字\motion-review`，包含空格的路径加引号。

## 关联游戏项目

在顶栏的项目切换器中选择自动识别建议或项目文件夹，也可粘贴路径。首次将当前已完成资料复制到项目 `.motion-studio/`，原目录保留；已有项目工作区直接打开。切换已关联项目不会带入另一项目资料。下次启动自动恢复最近可用项目。

这一个文件夹保存每次任务、候选、用户决定、验收检查点、按任务提取的工程上下文和缩略图缓存。点击“打开记录文件夹”即可在文件管理器查看。关联不会直接替换正式游戏文件。当前还有排队/运行任务时，先完成或停止，再迁入，避免复制成两份执行。

Agent也可直接运行 `node scripts/start.mjs --project "/absolute/path/game"`。更多说明见 [项目工作区](project-workspace.md)。

## 安装成 Skill

完整文件夹可放进项目 `.agents/skills/`，或复制到宿主的用户 Skill 目录：

```sh
node scripts/motion-feedback.mjs install --target "$HOME/.codex/skills/motion-stage"
```

Claude Code 可换成 `$HOME/.claude/skills/motion-stage`。Windows PowerShell 使用 `$env:USERPROFILE` 代替 `$HOME`。目标已存在时不会覆盖；先保留旧目录，再选择新目标。安装不改权限、模型设置或其他服务配置。新会话中调用 `$motion-stage` 或让 Agent 读取本包 SKILL.md；查看器也可独立运行。

## 导入自己的角色和动作

关联项目后，项目角色出现在左侧 **角色** 栏；**⋯ → 项目文件** 浏览目录及子目录中的全部模型与动作，打开时恢复各自版本与任务。也可点击 **＋导入** 添加独立模型或动作。原版和候选分别保存，导入不会替换源文件。支持：

| 输入 | 处理 |
|---|---|
| 自包含带动画 GLB | 直接预览、反馈和比较 |
| 自包含静态 GLB | 检查外形、表面、骨架；可提交制作任务 |
| 带角色及贴图的 FBX | 用本机 Blender 转为 GLB，保留原文件、可编辑 blend 与时间映射 |
| 只有骨架的动作 FBX | 提示下载当前角色的 With Skin，或提供实际角色和映射进行重定向 |
| UE uasset、Unity Prefab | 使用对应制作源导出；普通 GLB 不携带引擎行为 |

FBX 导入需要 Blender 4.2+；优先自动发现本机 Blender，或设置 BLENDER_EXECUTABLE。素材缺贴图时会说明原因，不把灰色替代材质当作正确结果。FBX 默认保留导入帧率；仅确认原下载设置后用 CLI `--fps 30` 等覆盖。

```sh
node scripts/motion-feedback.mjs add --workspace "/absolute/path/my-review" --slot baseline --file "/absolute/path/character.fbx" --new-model
node scripts/motion-feedback.mjs inspect --workspace "/absolute/path/my-review" --slot baseline
```

查看支持随包解码器可处理的 Meshopt、Draco、KTX2 等 GLB。确定性本地曲线编辑目前仅支持可读取的 LINEAR 四元数轨道；遇到压缩、STEP、CUBICSPLINE 或缺轨道时会拒绝，交给实际制作工具处理。

## 浏览角色动作

在 **动作库** 模式选择左侧角色，右侧列出它能播放的全部动作：**常用**、**角色自带**、**匹配动作**（自动在项目中找到的兼容动作）。点卡片立即播放，悬停看小预览，用分类标签或搜索筛选。详见 [动作库](action-library.md)。

## 提出修改

在动作卡片上点 **修改这个动作**，或切到 **修改** 模式。先找到动作和时刻。可点击角色表面定位，或在部位列表中确认。写一句话，例如“左手摆得太大，收一点，另一只手和脚步保持”。范围默认整个动作，局部修改请选一段时间。保留条件可选；不用填写三份技术表格。

点击 **连接 Codex 并开始修改**，即可连接本机已登录的 Codex CLI 并提交任务；已连接时按钮显示 **开始修改**。也可以选择 **只保存任务，稍后处理**。后台会启动真实的本地执行 worker。它使用你的模型配置和正常账号额度，任务在独立目录中执行，完成后候选自动返回。任务面板会切换为当前状态，显示真实阶段、最近活动、已用时间与上次更新时间，不显示推测的完成百分比。需要补充时直接回复一句话；失败时可保留原要求重新编辑。可以断开或停止任务。首次登录由用户在官方 CLI 流程中完成；不要把密钥粘贴进聊天。

没有连接 worker 时，Agent 可在现有会话中用 CLI 或 stdio MCP 领取任务。选区和保存意见本身不会让未连接的 Agent 自动开始思考。操作见 agent-workflow.md。

## 文件与迁移

- project.json 与 assets/：当前版本和按 SHA 保存的素材副本。
- jobs/：每条任务的冻结输入身份、context.json、task.md、截图、状态和执行结果。
- sources/：FBX 原始副本、转换结果、可编辑源和时间映射（实际目录以项目记录为准）。
- feedback.json、marks.json、snapshots/：兼容旧版的反馈、截图与评审历史。

复制工作区时保留所有素材和任务目录。原始导入的 GLB 记录相对路径；制作源记录可能包含当前机器的绝对路径，迁移后应检查 source 映射再执行原生编辑。查看和历史数据不依赖原游戏项目。

## 排错

- 页面无法渲染：检查 WebGL2、浏览器图形加速与页面显示的具体错误；**⋯ → 环境检查** 显示真实渲染器状态。
- 缩略图缺失或过旧：可直接删除工作区 `cache/thumbnails/`，下次查看时在浏览器中重新生成。
- 匹配动作看起来过旧：可直接删除工作区 `cache/actions/`，下次打开角色时重新匹配。
- Codex 无法连接：先在终端运行 `codex --version`、`codex login status`；已有任务保留，可继续通过当前聊天处理。
- 需要补充信息或执行失败：打开修改记录读取具体原因。不要把等待、失败或缺源当作已完成。
- 候选返回：页面自动进入同一时刻与镜头的对照，显示具体修改摘要和检查范围。可下载 GLB、选择保留，或点击 **基于这版继续调整**。历史结果在顶部 **修改记录** 查看。
- 候选过期：任务执行期间更换了素材。回到新版本定位后重新提交；旧结果不能覆盖新工作。
- 不同动作或变速后对不上：以秒为主检查范围、源起始帧与帧率；审阅帧号不是制作源帧号。
- 本地动作微调不可用：先确认具体旋转目标和支持的轨道；它不是任意角色的通用动作修复器。

程序只监听 127.0.0.1，模型与历史留在本机。连接在线 Agent 后，请求、选区信息和观察截图会进入该 Agent 的正常模型上下文。普通 GLB 不复现实时布料、引擎 IK、战斗混合或自定义材质；正式游戏效果仍需检查。
