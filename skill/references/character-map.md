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
