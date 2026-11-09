# 游戏状态预览

选择角色，再点 **游戏状态**。默认打开 **离线预览**。选一个状态并点 **在动作台预览**，便可用时间轴检查动作和并排比较两个版本。已应用的装备配置会随草稿和任务保存。点 **清除状态配置** 可恢复模型自带的装备挂点，点 **返回上一动作** 可恢复应用前的观察现场。

## 离线预览接入

打开状态窗口即可预览模型自带的动作。需要带上游戏设置时，在已关联的项目根目录提供 `motion-stage.states.json`。可以由项目的工具从自己的状态表导出。打开状态窗口或点 **刷新状态** 时，动作台会读取该文件。预览只需要动作台和已加载的模型。

```json
{
  "version": 1,
  "characters": {
    "hero": [
      {
        "id": "idle",
        "label": "收起武器待机",
        "clip": "Hero_Idle",
        "play": true,
        "appearance": "project",
        "attachments": [
          {"node": "Sword", "parent": "Scabbard", "position": [0, -0.008, 0]}
        ]
      }
    ]
  }
}
```

- `clip` 是动作台中对应的原始动作名。并排比较时，两个版本都需要该动作。可选的 `time` 指定从第几秒开始，默认从零开始。可选的 `play` 决定是否自动播放，默认停在指定时刻。
- `appearance` 可省略以沿用当前外观，也可选 `neutral` 或 `project`。项目外观使用已登记的本地适配包。 [项目外观接入](project-appearance.md)
- `attachments` 可省略。每个状态最多有 8 个相互独立的刚性装备挂点。用 glTF 中唯一的原始节点名填写 `node` 和 `parent`。局部变换可填 `position`、`quaternion` 和 `scale`，四元数按 `x, y, z, w` 排列。默认是零平移、单位旋转和单位缩放。装备跟随目标节点运动。

角色键优先匹配角色映射 ID，其次匹配主模型的项目相对路径，例如 `public/models/hero.glb`。每个角色最多 200 个状态。状态 ID 在角色内唯一，可用英文字母、数字、下划线、短横线或点。

## 游戏运行时接入

在 **游戏状态** 窗口选择 **游戏运行时**。动作台连接游戏提供的本地服务并嵌入预览页。布料、IK、战斗混合和运行时姿态修正由游戏预览页计算。要预览依赖历史的指定帧，预览页须先从已知初始状态推进模拟。

游戏服务提供一个可嵌入的预览页，以及一个返回 `application/json` 的状态目录。

```json
{
  "version": 1,
  "characters": {
    "hero": [
      {"id": "idle", "label": "待机", "path": "/dev/preview.html?character=hero&state=idle"},
      {"id": "hit", "label": "受击", "path": "/dev/preview.html?character=hero&state=hit"}
    ]
  }
}
```

运行时目录沿用相同的角色键和状态 ID 规则。预览路径以单个斜杠开头，由目录所在的游戏服务提供。

启动可信任的项目预览服务后，用工作区登记目录地址。游戏服务使用 `127.0.0.1` 和独立于动作台的端口。重跑连接命令可更换目录地址。

```sh
node scripts/motion-feedback.mjs runtime-connect --workspace "$WORKSPACE" --catalog "http://127.0.0.1:5173/dev/runtime-states.json"
node scripts/motion-feedback.mjs runtime-states --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID"
```

关闭游戏运行时窗口后，动作台继续原来的审阅。各状态能复现哪些系统取决于项目的预览页。需要读取正式游戏进程的当前状态时，由项目的调试服务提供该状态和预览入口。

## 按需启动项目预览

项目可以在根目录提供 `motion-stage.preview.json`，让动作台自动发现预览入口。这份声明、游戏服务的角色目录和下方的视口消息组成通用接入协议。项目可以复用已有的角色加载和渲染模块。

```json
{
  "version": 1,
  "entry": "dev/motion-stage-server.mjs",
  "catalog": "/__motion-stage/catalog"
}
```

`entry` 是项目内的 Node.js 模块，使用项目根目录作为工作目录。它只需启动预览所用的资源和渲染服务，在 `127.0.0.1` 上绑定由操作系统分配的端口，并通过 Node IPC 发送 `{type: "motion-stage-ready", port: 49152}`。收到 `disconnect` 时关闭监听和子任务。目录使用上节同样的格式，可以由项目从角色注册表、动作表和模型元数据生成。使用角色 ID 或模型相对路径作为键。尚未建立角色映射的工作区可以通过模型相对路径匹配。

首次接入时，审阅项目的启动模块及其依赖，再用以下命令登记。这个命令只登记本机对该项目的信任，不启动预览服务。声明或入口文件改动后重新审阅并登记。

```sh
node scripts/motion-feedback.mjs runtime-trust --workspace "$WORKSPACE"
```

切换到「游戏效果」或「游戏运行时」会启动预览并读取目录。多个窗口共用同一个服务，最后一个窗口关闭或切回资产预览时，动作台关闭服务。浏览器异常退出时，未续期的会话会在约一分钟后过期。手动连接的服务仍由使用者管理。`runtime-states` 读取手动连接的目录。按需服务从动作台的预览窗口访问。

运行时预览由项目的预览场景决定，例如可以复用游戏角色的装备、着色器和实时布料，同时使用专门的检查灯光。预览的是项目当前注册的游戏资产。动作台的未接入候选可在离线预览中对照。

## 主视窗的游戏效果模式

在主视窗选择「游戏效果」，动作台会按当前原版动作的项目相对文件路径和原始动作名称寻找对应状态。切换同角色的其他动作时会复用预览实例。初次切换会带入当前时间、播放状态和标准视角。游戏角色有自己的时间轴，切回「素材预览」可继续原来的观察、标记和版本对比。没有对应动作时会在主视窗提示，「游戏状态」菜单仍可预览项目登记的其他状态。

目录条目可加入以下字段来支持主视窗。提供该字段的预览页需要实现下方消息接口。

```json
{
  "id": "idle",
  "label": "待机",
  "path": "/dev/preview.html?character=hero&clip=Idle",
  "stage": { "file": "public/models/hero.glb", "clip": "Hero_Idle", "key": "Idle" },
  "capabilities": { "characterMaterials": true, "equipment": true, "liveCloth": true }
}
```

`file` 和 `clip` 指向动作台记录的源文件及源动作，组合模型用该动作所属的动画文件。每个角色内的来源组合应唯一。 `key` 是游戏预览页识别的动作。动作台打开页面时追加 `motionStage=1` 和 `parentOrigin`。预览页确认消息来自该来源的父窗口，初始化后向其发送 `{channel:"motion-stage",type:"ready"}`。

- 动作台发送 `{channel:"motion-stage",type:"select",request,key,time,playing,loop,speed,view}`。 `time` 以秒为单位， `view` 取 `front`、`side`、`back` 或 `top`。
- 预览页发送 `{channel:"motion-stage",type:"state",request,time,duration,playing}`。加载失败时发送 `{channel:"motion-stage",type:"error",request}`。 `request` 原样回传，动作台据此丢弃上一动作的迟到事件。
- 动作台发送 `{channel:"motion-stage",type:"play",playing}` 或 `{channel:"motion-stage",type:"seek",time}`。暂停和跳转由预览页执行并回报状态。有历史依赖的布料预览可以从已知初始状态推进到指定时间。

支持在同一页面切换角色的项目可以在 `stage.character` 提供角色 ID，并在 `ready` 消息中声明 `switchCharacter: true`。同源且路径相同的预览页可继续使用同一个渲染器，后续 `select` 会带上 `character`。按请求 ID 忽略过时的角色载入结果，并限制常驻角色资源。旧预览页仍会在跨角色时重新打开。

`capabilities` 可省略，已有目录可以继续使用。已知字段是布尔值。字段分别表示此状态复用角色材质（`characterMaterials`）、装备挂点（`equipment`）、实时衣料（`liveCloth`）、项目场景灯光（`sceneLighting`），或项目具备临时加载候选曲线的能力（`candidateClips`）。未知字段留给协议扩展。声明描述项目能力，当前视口的消息仍只播放注册的动作。

## 首次接入与对话交接

项目缺少入口、入口需要本机登记或当前动作缺少映射时，主视口会显示「让 Agent 接入」。点开后，动作台从工作区读取已关联项目、当前原版角色及选中动作的源文件与源动作名。组合角色同时带上动作台显示的动作名。接入任务要求复用现有加载与渲染逻辑，登记入口后回到原动作验证。完成后点「重新连接预览」，当前页面会重读目录。

本机 HTTP 接口 `POST /api/runtime-preview/handoff` 沿用会话令牌，接收 `{assetId,clip}`，无动作的素材使用 `clip:null`。返回 `{task,prompt,delivery}`。版本 1 的 `task.kind` 为 `runtime-preview-setup`，含 `workspace`、`project`、`character`、`action` 和启动会话的 `caller`。

能向已有对话发送消息的宿主，可在调用 `serve(work, port, options)` 时同时提供 `caller` 和异步 `sendToCaller({caller,task,prompt})`。宿主只向该绑定会话投递，确认收到后返回 `true`。未提供发送桥、未绑定会话或无法确认发送时，页面提供「复制接入任务」，也能手动选择任务文字。项目的预览代码无需实现对话发送。
