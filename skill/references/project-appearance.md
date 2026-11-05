# 项目外观适配

中性检查独立运行，默认不执行项目 JavaScript。它用于比较骨骼、姿势和形变，不代表游戏最终光影。项目外观通过显式安装的工作区适配包复用项目着色器与必要后处理；无适配包、当前角色未配置、来源变化、Three revision 不兼容、导入超时、初始化或编译失败时保留/重建中性预览。

## 项目首次接入

1. 只读检查实际角色构造器、材质替换、描边、灯光及后处理入口。确认 GLB 材质之外还有哪些代码负责外观；不得为补偿预览灯光而修改正式贴图或材质。
2. 在工作区 `appearance-authoring/` 编写适配入口，复制所需项目模块及经过审阅的依赖，记录原始源文件 SHA。只复用可独立工作的稳定部分，例如角色着色器、描边、曝光、色调映射。依赖战斗状态、场景遮罩、IK/布料的部分需明确列为未覆盖。
3. 模块依赖自包含于包内，允许 `three` 和已内置的 `three/addons/` 使用宿主 import map。其他依赖应预先打包或复制为相对模块，并保留许可证。可在编写适配时使用项目已有构建工具；普通启动、扫描、浏览和切换不运行构建工具、不安装 npm 包。适配器只从已审阅快照执行，不直接服务整个游戏目录。
4. 保存 manifest，通过下列命令显式安装，再在“视角与显示 → 角色外观”选择项目外观。安装不会执行入口。角色与任务数据、GLB 文件及正式项目源码不改变。

```sh
node scripts/motion-feedback.mjs appearance-install --workspace "$WORKSPACE" --file "$WORKSPACE/appearance-authoring/manifest.json"
node scripts/motion-feedback.mjs appearance --workspace "$WORKSPACE" --asset-id "$CHARACTER_ID"
```

```json
{
  "version": 1,
  "label": "我的项目 · 角色外观",
  "threeRevision": "186",
  "entry": "adapter.mjs",
  "files": ["adapter.mjs", "project/character-look.js"],
  "profiles": {
    "hero": {"preset": "hero"},
    "public/models/hero.glb": {"preset": "hero"}
  },
  "evidence": [{"file": "src/render/character-look.js"}],
  "limitations": ["使用检查舞台；不包含场景灯光和战斗事件"]
}
```

`profiles` 先以 `source.assembly.profileId` 匹配角色，再以主模型相对路径匹配原始文件。参数是 JSON，由项目适配器解释；核心没有项目名、骨骼名或材质名规则。路径支持 Unicode 和 Windows 分隔符输入；包内模块应使用可移植的相对 import。manifest 最多 1 MiB / 80 文件，单文件最多 8 MiB，整包最多 24 MiB；当前接受 JS/MJS/JSON，纹理可通过目标 GLB 的材质或模块内数据获得。

安装后，工作区 `appearance/<内容摘要>/` 保存不可变文件清单及快照，`appearance.json` 指向当前包。摘要包含适用项目、配置、模块和证据 SHA；来源变化后需审阅并重新安装。不要直接修改已安装快照。旧包保留用于来源追溯；当前代码不会自动使用已被新包替换的旧外观来恢复历史视图。MCP 对应 `motion_project_appearance` 和 `motion_install_appearance`，HTTP 状态为 `GET /api/appearance?assetId=...`，静态模块只开放清单内经过 SHA 验证的文件。

## 浏览器接口 version 1

```js
import { applyCharacterLook } from './project/character-look.js';
export const version = 1;
export function create({THREE, root, scene, camera, renderer, profile,
                        slot, environment, normalization, cleanup}) {
  const materials = [];
  cleanup(() => materials.forEach(material => material.dispose()));
  applyCharacterLook(root, profile, materials);
  return {};
}
```

`create` 必须同步返回。模块载入可以异步，但顶层只定义接口，不启动定时器、网络任务或修改宿主全局状态。资源释放通过 `cleanup(fn)` 注册，且应在可能失败的初始化之前登记；即使初始化抛错或第二个版本失败，已注册资源仍会释放。由适配器持有的材质、纹理、离屏目标、场景钩子及监听器都应释放；共享 GLB 纹理不得提前销毁。宿主随后释放整个模型。异步 `create` 会被拒绝。

输入是专为本次载入建立的模型、场景和相机引用。仅可修改这份副本的外观，不能修改动画轨道、骨骼姿态、几何形状或相机。几何增加着色属性、外部描边壳等可视组件应避免成为新的可选骨骼和动作目标。不得修改全局 `THREE.ShaderChunk`、原型、浏览器存储或模型/任务状态。该接口是经过审阅的本机代码扩展点，不是任意不可信 JavaScript 的沙箱。

可选返回值：

- `update({time, viewport})`：当前动作的实际秒数及当前版本的视口。只更新渲染状态；不能自行推进动作或依赖墙上时钟制造不同步的两个版本。
- `render({renderer, scene, camera, viewport})`：自定义后处理；省略时宿主直接绘制。`viewport` 为逻辑像素 `{x,y,width,height}`。离屏纹理尺寸按 DPR 计算；绘回默认目标时严格使用传入的逻辑视口和裁剪，兼容并排对照、缩放和四视图截图。

自定义后处理应拥有自己的离屏目标和 pass，禁止调整宿主 canvas 的尺寸或像素比。宿主会恢复 render target、viewport、scissor、autoClear、色调映射、曝光及输出色彩空间，并捕获运行时着色器编译失败；适配器仍需正确管理自身 GPU 资源。帧最终输出只进行一次 sRGB 编码，避免重复曝光或重复色调映射。图形运行能力必须在真实浏览器中验证。

## 切换、任务与验证

切换模式重新读取同一 GLB 版本对，不写资产、不推进 headRevision，不改任务。动作、时刻、镜头、选区、描述和候选保持；两个版本使用同一个包及角色参数。失败时整对重建为中性模式，不留下半套材质。中性模式不等待可选外观状态响应，也不导入项目模块；显式项目模式的状态及模块载入各有 5 秒期限。

观察上下文 `appearance` 记录模式、包摘要、参数、依据 SHA 和覆盖限制，供 Agent 判断着色器、灯光与模型的责任层。恢复草稿/历史现场时，只能恢复当前仍可用且摘要完全一致的外观，否则显示中性模式及解释。不要把预览外观问题当作 GLB 贴图损坏，也不要将项目外观截图声称为完整游戏运行时验收。

接入后至少验证默认中性、项目模式、切回中性、动作/镜头保持、双方对照、角色切换、截图，以及模块缺失/版本不兼容/编译失败的恢复。Shader revision 不匹配不做猜测替换。Unity、Godot 或其他渲染器的原生着色器不能直接作为 Three.js 模块导入，应使用经过审阅的导出/适配流程或原游戏运行时核验。
