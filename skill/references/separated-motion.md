# 分离动作与版本设计 · 3.2

## 使用流程

“角色与动作”是主入口，优先显示 character-map.json 中依据项目注册表确认的角色，包括尚未打开的角色。点击角色后用“打开角色并预览动作”直接播放现有动画，不必先建立公共库。项目中的制作源、旧模型、动作文件及构建副本保留在“项目文件”辅助入口，文件总数不代表角色数。

“试用其他动作”与“已保存动作”用于可选的公共动作复用；骨架映射、模型版本保留为进阶操作。角色类型可按网格、骨架/节点或曲线筛选；卡片显示独立身份与版本数。资源名称可修改，名称修改不建立跨角色关系。已查看的角色可使用实际预览缩略图；尚未查看的资源显示类型图标，不预先加载整个项目的网格。

从已有原版、候选或项目 GLB 提取公共库。FBX 先通过已有导入流程转换。公共包保留参考节点、层级、变换与动画曲线，不含网格、材质或蒙皮；不收录依赖具体网格的 morph weight 轨道。初次使用应人工检查实际动作效果。

选择库版本和片段后试播，模型保持已加载，只建立对应节点的 AnimationClip。普通轨道按节点实例 UUID 绑定，避免同名节点误选；原始 STEP、LINEAR、CUBICSPLINE 插值保留。结束试播还原原有动作，试播状态不写入普通修改草稿，也不能直接作为旧式任务输入。

“收录到角色动作”保存固定组合引用。角色动作按名称建立版本链，列表显示最新收录，详情可选择历史收录版本。公共源更新不会自动升级角色动作；可选择新源预览后明确收录。动作在一个角色上被收录，不代表已经在其他角色、实体引擎或所有时间点通过艺术验收。

“以此动作继续修改”生成工作候选，归档原有槽位，保留模型原版；同角色存在排队、运行或等待补充任务时拒绝准备。正常任务继续冻结自包含 GLB 输入并使用既有租约、检查、审阅和回退协议。角色专属修改留在自己的候选中；发布公共新版本是独立、明确的操作。

“导出 GLB”按需生成自包含下载，不写入新的模型 head 或持久保存额外合成文件。已有 GLB、旧角色关联、模型候选及任务历史继续可用，不强制拆解旧文件。

## 数据与一致性

- `project.json` v4 继续管理模型唯一槽位及历史修订；当前候选与原版同 SHA 时引用同一个文件。
- `motion-library.json` v1 独立管理 `packs[].versions[]`、`mappings[]`、`characters[assetId][]`，写入采用工作区锁及原子替换，并要求最新 `expectedRevision`。
- 公共 GLB 保存在 `assets/<SHA>.glb`，相同内容复用路径。原来源的身份、动作名、版本号和时间单独记录，不改变内容身份。
- 预览 recipe 固定模型 SHA、动作 SHA、片段名、映射 SHA、算法版本及目标角色/槽位；收录和准备必须匹配成功预览的 recipe ID。
- 保存映射前提供两套实际节点名称和对应表；只有目标唯一、父链和本地/世界参考变换兼容才通过。同名不等于兼容；不自动猜测骨骼语义或做任意重定向。
- 映射固定在准确资产版本上。直接兼容时可不使用显式映射。不同模型可以引用同一公共动作版本，但各有独立动画实例、收录和修改历史。
- 曲线派生缓存最多 32 项 / 16 MiB；复用前仍校验源资产字节 SHA，缓存不是权威数据。
- 项目关联迁移一并复制 manifest 和按 SHA 保存的资产，保留 recipe。备份整个工作区，不能只复制清单。

## API 与 Agent

HTTP：

- `GET /api/motions`：角色版本、公共库、映射和角色收录。
- `POST /api/motions/register`：从 `assetId + slot` 或项目 `sourceId` 提取；更新现有公共库可传 `packId`。
- `POST /api/motions/rigs`：获取来源必需节点与目标节点，用于对应表。
- `POST /api/motions/mapping`：保存 `nodeMap`，通过检查后产生不可变映射 ID。
- `POST /api/motions/preview`：验证并返回目标节点索引及曲线，无模型写入。
- `POST /api/motions/adopt`：用 `previewId + expectedRevision` 记录用户明确收录。
- `POST /api/motions/prepare`：显式生成工作候选，并在 `source.motionBinding` 冻结来源。
- `GET /api/motions/export`：同一组合按需导出 GLB。

写接口沿用本机会话 token、Origin 检查和工作区锁；所有资源定位都验证工作区或已关联项目边界。查询 preview/prepare/export 时固定 `assetId`、`slot`、`expectedModelSha`、`packId`、`versionId`、`clip`、可选 `mappingId`，收录和准备还需要 preview 返回的 `recipe.id`。

CLI `motion-library --workspace PATH` 读取清单；`motion-register / motion-preview / motion-mapping / motion-adopt / motion-prepare --workspace PATH --file PARAMS.json` 使用相同结构。MCP 为 `motion_asset_library / motion_register_pack / motion_rig_options / motion_save_rig_mapping / motion_preview_binding / motion_adopt_action / motion_prepare_action`。

## 验证边界

当前分离预览支持经检查的直接兼容骨架及名称映射；参考姿势、比例或层级不兼容时明确要求重定向。运行时 IK、服装模拟、握持约束与游戏状态机仍需对应制作/引擎流程。UI 中的成功兼容检查不等于动作自然、全程无穿模或已经完成正式游戏接入。
