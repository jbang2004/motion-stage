# 通用资源库

关联项目后，本地服务自动递归扫描；独立工作区仍支持手动导入。模型目录显示相对路径、格式、动作数量、预览状态及源文件更新。查询和分页在服务端执行，画面只载入选中的原版与候选。首次打开未修改的教学工作区时，优先预览目录中的首个有效 GLB；FBX 仍按用户打开操作转换。

## 身份、版本与兼容

`project.json` 使用 version 4。每个 `models[id]` 记录独立 `slots`、`headRevision`、来源及源更新前的 `revisions`，并以模型内的槽位为唯一内部版本来源。`activeAssetId` 指定当前模型，顶层 `slots` 仅作兼容投影。读取 version 3 时采用其当时的顶层活动槽位；更旧工作区按固定 `legacy` 身份迁移，第一次写入才保存新结构。旧任务、截图、上下文及验收证据不重写，未知的未来元数据版本会被拒绝。

扫描结果保存在 `catalog.json`。相对路径对应稳定 `assetId`，同名不同路径独立。相同 SHA 只复用存储，不能建立历史关联。改名或移动到另一相对路径目前作为新条目；原条目标记缺失，已有快照与任务保持。项目整体移动仍通过项目关联的相对根路径恢复。

新任务冻结 `assetId`、模型 `headRevision` 和两个输入的 SHA。浏览切换不改变 headRevision。完成与回退只更新任务所属模型；同模型版本变化、已绑定代码/制作源或 FBX 贴图变化仍拒绝旧任务回写。多个浏览器页可通过 URL `?asset=ID` 固定各自查看的模型。

目录刷新不会覆盖候选。打开已经导入的模型恢复其版本对；点击“载入源文件新版本”后，实际内容或消费依赖有变化才设置新的原版/候选并归档上一对；有效源内容未变时保留候选、headRevision 和待执行任务。源文件缺失时，已有预览和历史仍可查看。

## 扫描与格式

- 自包含 GLB 直接预览。扫描只读取 JSON 描述块，首次打开才校验并保存完整文件。
- FBX 首次打开调用 Blender 4.2+。带外部贴图时从原目录读取，原始 FBX 副本与打包后的 blend/GLB 留在工作区。只有骨架也可转换为独立骨架预览；实际节点、关节和动作保留。没有网格或骨架、缺失贴图等失败不覆盖已有版本。
- 采样动作 JSON 支持独立曲线预览。普通配置 JSON 不列为动作。目录只解析最多 8 MiB 的元数据；更大的已识别动作包只登记路径，打开时解析（最多 50 MiB）。损坏来源单独报错。
- `.gltf`、`.blend`、OBJ、VRM、BVH、USD、ABC、uasset、Maya、C4D 作为制作源显示，需要另行导出；当前不承诺直接预览。
- 不运行项目脚本，不遍历符号链接，忽略依赖目录、版本控制目录、生成目录与动作台工作区。原始文件不修改。
- 默认预算为 100000 个文件、20000 个目录、64 层、120 秒。GLB 描述块最多 8 MiB，直接预览文件最多 200 MiB。达到预算或部分目录不可读会显示未完整扫描，保留旧条目；只有完整扫描才将未发现的条目标记缺失。
- 扫描进度持久化，重复启动复用进行中的扫描。进程中断可刷新恢复。下次启动和手动刷新都会重新检查目录，未变化的 GLB 元信息可复用；没有常驻文件监听。

FBX 转换队列独立于工作区写锁，转换时其他模型仍可使用。缓存验证源 SHA、相对源路径、Blender 版本、转换脚本 SHA、帧率策略与实际读取的外部贴图 SHA。未消费的邻接图片不会成为任务依赖。刷新目录可发现已导入 FBX 的贴图变化。候选不因刷新自动重置，使用新源操作会重新核验缓存。转换生成的 editable.blend 是导入时制作源，后续曲线微调仍须遵守上游版本衔接规则。

目录索引按文件修订缓存排序与搜索结果，用 ID 集合合并已导入模型；分页不重复做平方级成员检查。扫描进程意外退出时，缓存页面也会显示可重新扫描的中断状态。提交恢复和环境验证范围见 [环境诊断与恢复](reliability.md)。

## CLI 与 MCP

```sh
node scripts/motion-feedback.mjs scan-models --workspace "$WORKSPACE"
node scripts/motion-feedback.mjs models --workspace "$WORKSPACE" --query hero --offset 0 --limit 100
node scripts/motion-feedback.mjs open-model --workspace "$WORKSPACE" --asset-id "$ASSET_ID"
node scripts/motion-feedback.mjs open-model --workspace "$WORKSPACE" --asset-id "$ASSET_ID" --refresh-source
node scripts/motion-feedback.mjs inspect --workspace "$WORKSPACE" --asset-id "$ASSET_ID" --slot candidate
```

`add --new-model` 建立独立模型；保留原有 CLI `add --slot` 的当前模型槽位更新语义，支持 `--asset-id` 明确目标。后台任务不依赖当前浏览选择。

MCP 为 `motion_list_models`、`motion_scan_models`、`motion_open_model`。列表包含扫描状态；扫描工具启动后台扫描，继续查询列表可读取实际进度。`motion_inspect_asset` 与即时 `motion_project_context` 支持 `assetId`。

HTTP 为 `GET /api/catalog?query=&offset=&limit=`、`POST /api/catalog/scan`、`POST /api/catalog/:assetId/open`。打开参数为 `refreshSource`。`/api/session`、`/api/studio` 接受 `assetId` 查询参数；任务提交携带 `assetId`。写接口沿用本机会话令牌和同源校验。

## 独立预览与资源能力（2.7）

`resource-capabilities.mjs` 是服务端与查看器共用的分类入口，元信息提供 `capabilities.version:1`。网格、骨架、蒙皮、节点层级、变形目标与动画分别记录。查看器从真实 GLB 再识别一次，旧版本无需迁移或重写。

| 实际内容 | 预览与边界 |
| --- | --- |
| 只有网格 | 静态模型；播放停用，可反馈造型 |
| 网格 + 骨架，无动作 | 静止姿势；不假定已有兼容动作 |
| 只有骨架 + 动作 | 实际节点连线、关节点、选中节点朝向与动作；不能证明蒙皮变形 |
| 普通节点 + 动作 | 节点层级预览；名称不证明生物骨骼身份 |
| 只有采样曲线 | 轨道、分量、时刻与数值曲线；不创建示例角色或默认骨架 |
| 空容器 | 资源信息与限制；停用修改提交 |

没有场景的 GLB 使用其实际根节点；只有网格库而无节点/场景时直接预览实际网格。空间无跨度时只采用有限的相机构图尺度，不补造关节。交互节点超过 5000 时明确要求拆分资源，目录及既有版本保持。静态模型无需 Blender 或 Agent；FBX 仅在首次使用时检查 Blender。无 WebGL2 时曲线仍可查看，三维资源给出环境恢复入口。

独立采样 JSON 使用已有 `sampled-tracks-v1` 格式：`fps`、`clips` 对象，片段含 `duration` 与 `tracks`，每条轨道为 `[binding, kind, width, flattenedValues]`。`kind` 为 `quaternion` / `vector` / `number`；无目标的轨道名称也可查看。只有显式关联至目标模型后才检查能否绑定；独立预览不宣称坐标系或参考姿势兼容。

原 JSON 按 SHA 冻结到 `sources/`。为复用既有版本、任务和下载协议，曲线预览存为自包含 GLB 检查容器：`extras.motionStudio = {version:1, resource:'sampled-tracks-v1', fps, clips}`，轨道含 `binding/kind/width/input/output`；输入和展开输出分别指向 SCALAR float accessor。容器没有虚构的节点、网格或普通 glTF 动画，普通游戏加载器不会播放它。候选继续返回同类 GLB 容器；`inspect` 显示能力与描述，数据可用 accessor 读取。接回原项目需显式导出其所用 JSON/引擎格式，不能把检查容器当成游戏运行时动画。

曲线反馈冻结所选轨道、分量、时刻与合成截图。候选对照同步所选轨道，使用共同的数值轴；绘图降采样保留每个区间的极值。模型、骨架、曲线共用原有模型 ID、版本、候选、任务和恢复逻辑，避免另一套记录系统。必要检查拒绝损坏 accessor、时间顺序、零旋转及丢失原网格/骨架/曲线或必需动作；失败不提交新版本。

## 角色与分离动作


存在显式映射时优先展示角色；没有映射时默认展示全部资源，覆盖纯模型与纯动作项目。“角色”视图仍可查看带蒙皮或动画的待确认候选。“全部资源”始终保留静态道具、骨架、动作与制作源，FBX 按需转换。扫描找到文件不等于已确认运行时角色：应读取项目的 manifest、角色注册表、Prefab/场景引用，判断哪些是当前模型、历史版本、动作包或演示素材。

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

`glb` 接受分离或带网格的自包含 GLB。每条已选轨道必须能唯一绑定，检查全部父链、局部和世界参考变换；名字相似或同为人形不足以通过。支持内置 meshopt 动作解码与规范允许的量化旋转。不同骨架、参考姿势或坐标单位保留为需要重定向；不自动推测重定向。`nodeMap` 可显式映射名称，仍须通过参考变换校验。可用 `clips` 只选指定动作；重名须设置 `prefix`，或明确 `replace:true` 才覆盖已有名称。

`sampled-tracks-v1` 是明确声明的、面向目标模型的本地采样曲线格式，不是任意 JSON 的通用识别器：

```json
{"fps":60,"clips":{"Pose":{"duration":1,"tracks":[
  ["Hips.quaternion","quaternion",4,[0,0,0,1]],
  ["Hips.position","vector",3,[0,1,0]]
]}}}
```

关键帧按 `i/fps` 采样，常量轨道补到 clip 时长，允许末帧时长的半个采样间隔舍入误差。该格式没有源参考骨架，因此依赖显式的项目目标声明与依据；仍校验唯一节点、维度、有限值和时间。格式无法确认时用 `unsupported`，等待项目导出器。映射最多 1 MiB / 500 角色，每角色最多 50 动作源；单个外部源最多 50 MiB，压缩动作最多展开 128 MiB，合成预览最多 200 MiB。

每个来源独立合成，出错时整份来源跳过，保留其他已验证动作及原模型。预览及每个动作的文件、原名、解析格式记录在 `source.assembly`。任务冻结已消费动作源、项目依据与该角色绑定声明；源变化会阻止过期结果回写。改其他角色、重命名、修改版本归组或只触碰文件时间不应重置当前候选。合成角色有独立身份，不接管旧单文件历史；旧记录继续保留在文件视图。已有快照在来源缺失、映射删除或损坏时仍可打开。

```sh
node scripts/motion-feedback.mjs character-map --workspace "$WORKSPACE" --file reviewed-map.json
node scripts/motion-feedback.mjs characters --workspace "$WORKSPACE"
node scripts/motion-feedback.mjs open-character --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID"
node scripts/motion-feedback.mjs associate-motion --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID" --source-id "$FILE_ID"
node scripts/motion-feedback.mjs open-character --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID" --refresh-source
```

显式保存 map 会替换整个声明文件，编辑前读取并保留其他角色。UI 的“关联到当前角色”仅增加选定来源，先做兼容检查，使用文件名前缀避免重名，并防止并发映射覆盖；之后由用户载入源文件新版本。它不会证明该动作在游戏中被使用。

MCP 对应 `motion_list_characters`、`motion_save_character_map`、`motion_open_character`、`motion_associate_motion`。HTTP 增加 `GET /api/characters`、`POST /api/characters/map`、`POST /api/characters/:id/open`、`POST /api/characters/:id/associate`，沿用会话令牌。所有旧目录 API 保持文件级语义。浏览器仅加载选中角色的版本对，不一次载入整个工程的几何数据。

这些预览覆盖可确认的文件动作，不保证包含游戏运行时的 IK、布料、动作状态机叠加、程序动画、远程资源或未支持的引擎二进制。普通项目应通过声明或项目导出器接入这些来源，不能声称仅选择目录就一定还原所有运行时表现。

## 通用构图与重名节点

空间预览按真实包围盒的最大轴归一化，查看中心采用实际高度中点，避免把宽扁物体按人物身高放大裁切。记录中的 normalization 保留实际比例与原始高度。重复骨骼名通过 glTF 节点索引区分，旧的唯一名称仍可读取；不明确的重名选择不会自动指向第一副骨架。本地微调沿用冻结的节点索引。多蒙皮可能共享同一关节树，不能只按 skin 数量推断独立骨架数。

GLB 支持使用随包解码器处理 EXT/KHR Meshopt、Draco 和 KTX2/BasisU；元数据、必要文件检查和外部动作组合共用 Meshopt 扩展识别。压缩轨道不在本地数值微调中直接当未压缩数据读取。

FBX 转换收集原生绑定、Action Slot 和旧导入器的明确目标前缀，保留非活动 Take；同一 Take 下不同对象的动作按原时间偏移合并。无法唯一确定目标或缺少应导出的片段时明确失败，避免返回悄悄丢动作的模型。保存的 editable.blend 也保留非活动动作。升级不改写已有版本；项目 FBX 可通过“重新转换 FBX”显式采用新转换器，实际输出变化才归档旧版本。

节点索引只在对应的文件身份内有效。候选重新导出后，只有相同节点描述布局才沿用索引；否则仅恢复唯一名称，重名且布局变化的选区需重新点选，避免跨版本指向另一副骨架。
