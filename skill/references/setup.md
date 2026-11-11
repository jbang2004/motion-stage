# 安装与运行

以下命令均在安装包根目录运行；从源码仓库使用时先 `cd skill`。

## 启动

需要 Node.js 22+ 和支持 WebGL2 的浏览器，无需 `npm install`。macOS 双击 `Open MotionStage.command`，Windows 双击 `Open MotionStage.cmd`，或运行：

```sh
node scripts/start.mjs
```

自动选择空闲端口并打开浏览器。首次在 `~/motion-stage-workspace/` 创建练习，下次恢复最近的可用项目；已有旧版 `motion-feedback-workspace` 会继续沿用。保持终端运行，`Ctrl+C` 停止，不要直接打开 `index.html`。

按需指定项目或独立工作区（二选一）：

```sh
node scripts/start.mjs --project "/absolute/path/to/game"
node scripts/start.mjs --workspace "/absolute/path/to/review"
```

加 `--no-open` 可只打印地址。Windows 路径如 `C:\Users\你的名字\motion-review`，包含空格时加引号。

## 安装为 Skill

选择对应客户端的命令；目标目录须不存在，升级前先停止旧服务并保留旧目录：

```sh
# Codex
node scripts/motion-feedback.mjs install --target "$HOME/.codex/skills/motion-stage"
# Claude Code
node scripts/motion-feedback.mjs install --target "$HOME/.claude/skills/motion-stage"
```

Windows PowerShell 将 `$HOME` 换为 `$env:USERPROFILE`。新开对话调用 `$motion-stage`，或让 Agent 读取本包 [SKILL.md](../SKILL.md)。查看器可独立运行。

## 项目与导入

左上角「关联项目」选择工程文件夹。首次关联可迁入当前素材和记录，原目录保留；已有项目直接打开。迁入前先完成或停止排队、运行中的任务。

素材、任务、候选、草稿和决定都在 `<项目>/.motion-studio/`，迁移时复制整个文件夹。制作源可能记录绝对路径，换机器后需核对源文件映射。详见 [项目工作区](project-workspace.md)。

用「＋导入」添加素材，「⋯ → 项目文件」浏览项目文件：

| 输入 | 要求 |
|---|---|
| 自包含 GLB（静态或带动画） | 直接查看，支持随包解码器可处理的 Meshopt、Draco、KTX2 |
| FBX（角色、动作及贴图） | 本机 Blender 4.2+；自动查找，或用 `BLENDER_EXECUTABLE` 指定 |
| 只有骨架的动作 FBX | 需同角色的 With Skin 模型，或提供目标角色做重定向 |
| UE uasset、Unity Prefab | 先从对应制作工具导出 |

FBX 转换保留原文件、可编辑 `.blend` 和时间映射；默认沿用导入帧率。不同骨架不能仅靠格式转换匹配。更多格式说明见 [资源库](asset-library.md)。

## 提交与比较

选角色 → 点动作卡片 →「修改这个动作」→ 暂停、选部位、写要求。局部修改可选时间范围，多处问题可逐一「标记当前画面」。

| 处理方式 | 操作 |
|---|---|
| 当前对话处理（默认） | 保存后复制任务给当前 Agent；保存本身不会唤醒对话 |
| 本机后台处理 | 选择已配置的 Codex CLI、Claude Code 或 DeepSeek Harness，提交后运行独立任务，使用该客户端的模型与账号额度 |

后台扫描只检查可执行接口；登录、额度和权限在执行时验证。未接入执行适配器的应用不可选，失败时不会自动切换客户端。DeepSeek Harness 可自动发现 PATH 或 macOS 应用内的 `dsh`，其他位置用 `DEEPSEEK_EXECUTABLE` 指定。执行细节见 [Agent 工作流](agent-workflow.md)。

由 Agent 打开时，会绑定调用客户端与当前会话。旧任务继续交给原会话；若原会话无法继续，取消旧任务，再从新会话打开动作台并提交。

候选回来后，在同一时刻与镜头下比较，选择「采用这版」「继续调整」或「不用这版」。原版保留；正式游戏文件通过「接入游戏…」另行处理。只想体验可用「本地微调」调整摆幅或旋转偏移；仅支持可读取的 LINEAR 四元数轨道。

## 常见问题

- **三维画面打不开**：查看「⋯ → 环境检查」，确认 WebGL2 与浏览器图形加速可用。
- **缩略图或匹配动作过旧**：删除工作区 `cache/thumbnails/` 或 `cache/actions/`，重新打开角色后自动生成。
- **任务一直等待或失败**：检查是否已交给 Agent，打开任务记录读取具体原因；后台模式需确认客户端已登录且可执行。
- **候选过期**：素材在执行期间发生变化，回到新版本重新提交。
- **源帧号或变速后对不上**：按秒核对范围、制作源起始帧和帧率。

更多恢复操作见 [环境诊断与恢复](reliability.md)。程序只监听 `127.0.0.1`，模型与历史保存在本机；连接在线 Agent 后，要求、选区和截图会进入其模型上下文。普通预览不复现游戏中的实时布料、IK 或战斗混合。
