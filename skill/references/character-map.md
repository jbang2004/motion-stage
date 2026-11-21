# 角色声明 · character-map.json

Read this before you declare which model, variants and external motions belong to a project character. Declared characters lead the 角色 rail and the 动作库 panel (see [action-library.md](action-library.md)). For reusable motion packs and name mappings, read [separated-motion.md](separated-motion.md). Those packs are the preferred way to *try* a shared motion. This declarative composite flow stays fully supported for existing project declarations, and it does not rewrite or split existing tasks or checkpoints.

## Ownership rules

- Embedded clips belong to their model.
- An external motion belongs to a character only when the project's actual registry says so (manifest, character registry, Prefab or scene references) or the user chooses it. Similar names, matching bone names or a shared skeleton do not establish ownership.
- Read the project registry read-only. Never execute project code to find out, and never add project-specific rules to the scanner.
- A file found by the scan is not a confirmed runtime character. Decide which files are the current model, historical versions, motion packs or demo assets from the registry.

## 角色展示

有声明时，角色栏优先展示已声明的项目角色；**全部角色** 还会列出项目中其他带蒙皮的模型。没有声明时，按带网格的模型展示，覆盖纯模型与纯动作项目。**⋯ → 项目文件** 始终保留全部资源：静态道具、骨架、动作与制作源，FBX 按需转换。

## 声明格式

角色关联只保存在工作区 `character-map.json`。Agent 首次分析项目时可保存如下声明，后续预览不调用模型推理，也不运行游戏代码。路径相对当前关联项目根目录，支持 Windows 分隔符输入，落盘统一为 `/`。

```json
{
  "version": 1,
  "characters": [{
    "id": "hero",
    "name": "主角",
    "model": "public/models/hero.glb",
    "variants": ["public/models/hero-old.glb"],
    "animations": [
      {"file": "public/models/exploration.glb", "format": "glb"},
      {"file": "public/models/director.json", "format": "sampled-tracks-v1"}
    ],
    "evidence": [{"file": "src/characters/hero.js"}]
  }]
}
```

保存时校验项目边界，并冻结 evidence 文件 SHA。依据变化后，外部来源标记需要确认；主模型仍可返回。重新阅读注册表、核对关联后，重新保存经确认的声明（旧 evidence SHA 不一致会拒绝保存，可在确认后移除旧 SHA 让保存操作重新计算）。`variants` 仅归组，不自动从旧模型借动作。普通目录如果无显式项目注册信息，保留候选，由用户明确关联；不能把同一骨架的所有动作自动归给所有角色。

## 动作来源格式

`glb` 接受分离或带网格的自包含 GLB。每条已选轨道必须能唯一绑定，检查全部父链、局部和世界参考变换；名字相似或同为人形不足以通过。支持内置 meshopt 动作解码与规范允许的量化旋转。不同骨架、参考姿势或坐标单位保留为需要重定向；不自动推测重定向。`nodeMap` 可显式映射名称，仍须通过参考变换校验。可用 `clips` 只选指定动作；重名须设置 `prefix`，或明确 `replace:true` 才覆盖已有名称。

`sampled-tracks-v1` 是明确声明的、面向目标模型的本地采样曲线格式，不是任意 JSON 的通用识别器：

```json
{"fps":60,"clips":{"Pose":{"duration":1,"tracks":[
  ["Hips.quaternion","quaternion",4,[0,0,0,1]],
  ["Hips.position","vector",3,[0,1,0]]
]}}}
```

关键帧按 `i/fps` 采样，常量轨道补到 clip 时长，允许末帧时长的半个采样间隔舍入误差。该格式没有源参考骨架，因此依赖显式的项目目标声明与依据；仍校验唯一节点、维度、有限值和时间。格式无法确认时用 `unsupported`，等待项目导出器。映射最多 1 MiB / 500 角色，每角色最多 50 动作源；单个外部源最多 50 MiB，压缩动作最多展开 128 MiB，合成预览最多 200 MiB。

## 合成预览与版本

打开角色时，从已确认来源合成工作区自有的预览，对外部 GLB 动作检查节点绑定、参考变换与层级。每个来源独立合成，出错时整份来源跳过，保留其他已验证动作及原模型；不支持或不兼容的来源保持可见。预览及每个动作的文件、原名、解析格式记录在 `source.assembly`。任务冻结已消费动作源、项目依据与该角色绑定声明；源变化会阻止过期结果回写。改其他角色、重命名、修改版本归组或只触碰文件时间不应重置当前候选。合成角色有独立身份，不接管旧单文件历史；旧记录继续保留在文件视图。已有快照在来源缺失、映射删除或损坏时仍可打开。

**载入源文件新版本** 明确采用源文件变化并归档上一对版本；刷新目录只发现变化，不替换候选。

**源文件更新按动作分拣旧工作**（4.7，`scripts/source-sync.mjs`）。载入新源时，逐个动作比较旧源与新源（关键帧与数值，含 meshopt 压缩动画）：

- 每条在旧源上做的任务记下 `sourceUpdate`：它的动作在新源中 `unchanged`、`changed`、`removed` 或 `unverified`（无法配对或读取时从不当作相同）。排队或等待补充的任务立即转为 `stale` 并写明原因；动作没变的会注明可在新版本上重新提交。
- 候选按动作处理：候选相对其来源改过的动作，若在新源中未变，就把这些动作的轨道（解码后）写进新源，作为新候选“沿用候选 · 动作名”，原任务记下 `sourceUpdate.rebased` 新的版本对，界面用它打开对照；新源中已改变或删除的动作不沿用，旧的版本对保留在模型 `revisions`。一次源更新只增加一次 `headRevision`。
- 结果写入模型的 `sourceUpdate`（`carried`、`dropped`、`tasks`），界面横幅据此说明沿用了什么、归档了什么。
- 仍会阻止载入的只有：角色有**正在执行**的任务（错误码 `MODEL_JOB_ACTIVE`），以及**未提交草稿所指的动作在新源中改变或删除**（草稿原样保留）。候选、排队任务和其他动作的草稿不再阻止。

**动作台跟随游戏文件**（`scripts/source-watch.mjs`）。由 `start.mjs` 或 CLI `serve` 启动的动作台，会轮询每个已打开角色在 character-map 中声明的主模型与动作来源文件（按大小、时间与 inode，安装时“写新文件再改名”也能发现）。文件变化并静止约 1.2 秒后，自动按上面的规则载入新源，不切换页面正在看的角色；被阻止时在横幅显示原因并可“重试载入”（`POST /api/characters/:id/sync`）。启动时也会检查一次，关闭期间安装的新模型会在打开时载入。`serve --no-watch` 关闭跟随。

## Source verification and delivery

游戏模型安装后，先从实际运行时注册表确认角色的主模型、外部动作所有者和依据文件，再核对 map。不要按文件名、修改时间或同骨架关系推测正式版本，也不要把工程路径写死为某个引擎的目录。保存 map 前读取并保留其他角色；依据变化须重新阅读，不能只删除旧 SHA 来绕过确认。

对一个已声明角色执行只读来源检查（`profile-id` 是 map 中的角色 ID）：

```sh
node "$CLI" character-source --workspace "$WORKSPACE" --profile-id "$PROFILE_ID"
```

结果分别给出 `sourceSha256`（当前主源）、`snapshotSourceSha256`（快照的主源）和 `previewSha256`（合成预览）。GLB 的源 SHA 是正式文件 SHA；glTF 的源 SHA 是 JSON 主文件 SHA，另用 `sourceDependencies` 和 `sourceFingerprint` 核对引用的 buffer/纹理；仅 JSON SHA 相等不足以证明版本相同。合成预览加入外部动作后，其 SHA 通常不同，不能要求预览 GLB 与游戏主 GLB 完全相同。`motionSources` 记录各外部来源状态；`blockers` 列出草稿、独立候选、未完成任务和未确认依据。

`current` 表示声明与已载入源一致，尚不证明声明就是游戏实际使用的路径。`stale`、`unopened`、`mapping-mismatch`、`source-mismatch`、`unavailable`、`incomplete` 均未通过交付同步验收。未打开的角色只读检查不会自动导入。CLI 仅 `current` 返回成功。

在用户已授权的角色安装/同步范围内，用经注册表核实的主模型路径和安装版本 SHA 显式刷新所选角色：

```sh
node "$CLI" character-source --workspace "$WORKSPACE" --profile-id "$PROFILE_ID" \
  --model "$RUNTIME_MODEL" --source-sha256 "$INSTALLED_SOURCE_SHA" --refresh-source
```

刷新拒绝预期路径或 SHA 不符、正在执行的任务，以及所指动作已被新源改变或删除的未提交草稿；草稿不会被清除。候选与排队任务按上文“源文件更新按动作分拣旧工作”处理，不需要先手动归档。通过时原版本进入历史，projectId、角色 ID 不变，旧任务带上 `sourceUpdate`。重复刷新同一源不重置版本。glTF 刷新必须额外传 `--source-fingerprint`（从已核对的安装版本检查结果取得），以固定 JSON 及全部引用依赖；旧依赖指纹会拒绝刷新。命令支持 GLB/glTF 主源；FBX 沿用转换和依赖验证流程。外部源未能完整合成会报告 `incomplete`，不能声称已同步完成。

无法访问外置盘、来源有冲突或尚未解决草稿时，交付报告明确写出“游戏已更新、动作台待同步”及原因。仅扫描目录、修改 map 或打开临时导入都不算同步验收。机器检查之后，在实际动作台 URL 核对角色身份、脸/服装与代表动作；游戏效果仍需实际游戏验证。

```sh
node scripts/motion-feedback.mjs character-map --workspace "$WORKSPACE" --file reviewed-map.json
node scripts/motion-feedback.mjs characters --workspace "$WORKSPACE"
node scripts/motion-feedback.mjs open-character --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID"
node scripts/motion-feedback.mjs associate-motion --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID" --source-id "$FILE_ID"
node scripts/motion-feedback.mjs open-character --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID" --refresh-source
```

显式保存 map 会替换整个声明文件，编辑前读取并保留其他角色。UI 的“关联到当前角色”仅增加选定来源，先做兼容检查，使用文件名前缀避免重名，并防止并发映射覆盖；之后由用户载入源文件新版本。它不会证明该动作在游戏中被使用。

MCP 对应 `motion_list_characters`、`motion_save_character_map`、`motion_open_character`、`motion_associate_motion`。HTTP 为 `GET /api/characters`、`POST /api/characters/map`、`POST /api/characters/:id/open`、`POST /api/characters/:id/associate`，沿用会话令牌。所有旧目录 API 保持文件级语义。浏览器仅加载选中角色的版本对，不一次载入整个工程的几何数据。

## 覆盖范围

这些预览覆盖可确认的文件动作，不保证包含游戏运行时的 IK、布料、动作状态机叠加、程序动画、远程资源或未支持的引擎二进制。普通项目应通过声明或项目导出器接入这些来源，不能声称仅选择目录就一定还原所有运行时表现。复合角色任务先按 `job.source.assembly.clips[clip]` 找到实际负责的来源，见 [agent-workflow.md](agent-workflow.md#build-and-return)。
