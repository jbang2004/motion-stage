# 动作库 · Action library

Read this when the user wants to see what a character can do, find actions for a character, or try an action from another file on it. To register reusable packs and name mappings, read [separated-motion.md](separated-motion.md). To declare which files belong to a character, read [character-map.md](character-map.md).

## What the user sees

| Area | Content |
|---|---|
| 角色 rail (left) | Project characters as rendered portrait thumbnails. **全部角色** opens a gallery that also lists the other skinned models in the project. |
| Stage (centre) | The selected character playing the selected action on its real rig. |
| 动作库 panel (right, in 动作库 mode) | One thumbnail card per action the character can play, rendered *on that character*. |

The panel has three sections:

| Section | Contains | Where the data comes from |
|---|---|---|
| 常用 | Actions the user explicitly adopted for this character | `motion-library.json` → `characters[assetId]`; `saved` in `GET /api/actions` |
| 角色自带 | Clips embedded in the character's model, plus animations declared for it in `character-map.json` | The opened model or composed preview (`source.assembly`) |
| 匹配动作 | Compatible actions found elsewhere in the project | The discovery scan below (`GET /api/actions`, MCP `motion_available_actions`) |

Card behaviour:

- Tap a card: the stage plays it immediately. Playback is transient.
- Hover a card: a live mini preview plays inside the card.
- **修改这个动作**: switches to 修改 mode with that action selected, ready for a one-sentence request.
- Category chips **全部 / 待机 / 移动 / 攻击 / 技能 / 防御 / 受击 / 跳跃 / 倒地 / 表演 / 其他** filter the cards. Search matches the Chinese label, the English title and the raw clip name.

## How characters are listed

`GET /api/cast` builds the roster in three ranks, sorted by name within each rank:

1. Characters declared in the workspace `character-map.json` (`confirmed: true`). These are the project characters.
2. Other skinned or animated GLBs the project scan found as character candidates. The **全部角色** gallery shows them.
3. Workspace-only models with a mesh, such as the teaching character or imported files.

`?scope=confirmed` returns only declared characters. Each entry carries `clipCount`, `embeddedCount`, `externalCount` and a `portrait` source: workspace bytes for an opened model, or `GET /api/characters/<id>/model` for a project GLB that has not been opened. That endpoint serves the main model bytes of a declared or discovered GLB character in a linked project. Building the roster never opens, assembles or activates a character.

Being listed proves only that a file exists. It does not prove the game uses that model, or that a motion belongs to it. See [character-map.md](character-map.md).

## How 匹配动作 are discovered

Implementation: `scripts/character-actions.mjs`. Discovery is read-only. It never adopts an action, never writes a model head and never loads another model's geometry or textures.

1. **Target.** The selected character version: `assetId`, `slot` (`baseline` or `candidate`) and optional `expectedModelSha`. The snapshot bytes are re-hashed first. A changed version is refused (`角色版本已变化`). The character's own clips are hashed so they can be excluded.
2. **Inventory.** Each file is considered once:
   - model versions in the workspace (non-archived heads that carry clips);
   - immutable motion-pack versions;
   - with a linked project, catalog GLBs that are available and have clips. Animation-only GLBs come first.

   The inventory is cached until `project.json`, `catalog.json`, `motion-library.json`, `character-map.json` or `project-link.json` changes. FBX joins only after its explicit import conversion. Discovery never starts conversions.
3. **Read budget.** Only the GLB JSON chunk (≤ 8 MiB) and the animation buffer views (≤ 32 MiB each) are read. The GLB must be self-contained (embedded BIN) and ≤ 200 MiB, with ≤ 5000 nodes and ≤ 1000 animations.
4. **Binding check.** Every channel of a clip must pass:
   - its target node resolves by name (exact, or three.js-sanitised) to exactly one node in the character. A pack with a saved mapping for this exact target SHA resolves through that mapping's `nodeMap`;
   - local and world rest matrices are equal (relative tolerance 1e-5);
   - the whole parent chain matches by (mapped) name and local matrix, at the same depth;
   - the track is rotation, translation or scale, with LINEAR, STEP or CUBICSPLINE interpolation and no sparse accessor. Morph `weights` tracks are mesh-specific, so they make the clip ineligible.

   One failing channel rejects the whole clip and counts it under `incompatible`. "Incompatible" does not mean broken. It means the clip needs an explicit retargeting task.
5. **Exact-duplicate removal.** Each clip gets a SHA-256 over its sorted (target node, path, interpolation), its accessor layout and its raw curve bytes. Meshopt views are hashed as encoded. A clip identical to one the character already has is dropped. The same curves in several files become one row with `sourceCount` > 1. Only exact encodings merge; uncertain layouts stay separate.
6. **Preset variants.** A matched row with the same name as one of the character's own clips but different curves gets `presetVariant: true`. A shared name never stands in for shared content.
7. **Deadline.** Each scan has 120 s. After that its state becomes `partial` and the rows matched so far are kept. The scan yields between sources, so playback stays responsive. Each source's fingerprint (device, inode, size, mtime, ctime) is checked around the read; a file that changes mid-read is skipped and counted as an error.
8. **Speed and cache.** Each source's sampler data is read in one span when it sits together (most exporters), and up to four sources are read ahead while results still merge in inventory order, so labels and duplicate winners do not depend on timing. Per-source results are kept in `<workspace>/cache/actions/<target model SHA-256>.json`, keyed by source path, fingerprint and rig mapping. Restarts and one-shot CLI runs reuse them, and a changed file is matched again. A complete scan rewrites the file with only the sources it saw. The cache is git-ignored and always safe to delete.
9. **States.** `scanning` → `ready` | `partial` | `failed`. A scan restarts when the inventory changes, or on request with `refresh=1`. Stopping the server stops the scan.

`GET /api/actions?assetId=&slot=&expectedModelSha=[&refresh=1]` and MCP `motion_available_actions` return the same shape: `state`, `checked` / `total`, `incompatible`, `duplicates`, `error`, `characters`, `saved`, and `actions[]` with `id`, `name`, `duration`, `sourceName`, `sourceCount`, `origin`, `presetVariant`. Poll while `state` is `scanning`.

## Categories are hints

Implementation: `assets/viewer/action-taxonomy.mjs` (pure module: `ACTION_CATEGORIES`, `classifyAction`, `actionSearchText`, `compareActions`). The taxonomy reads only the clip name, plus its duration for single-frame poses.

| Chip | id | Typical name words |
|---|---|---|
| 待机 | `idle` | idle, breathe, stance, wait, rest, stand |
| 移动 | `move` | walk, run, sprint, strafe, jog, turn, start, stop, dash |
| 攻击 | `attack` | slash, attack, combo, punch, kick, stab, swing, heavy, finisher |
| 技能 | `skill` | skill, special, ultimate, cast, charge, buff, power up |
| 防御 | `defense` (module label 防御/闪避) | guard, block, parry, dodge, evade, roll, backstep |
| 受击 | `hit` | hit, damage, hurt, stagger, knockback, flinch, impact |
| 跳跃 | `air` | jump, air, fall, land, flip, leap, dive |
| 倒地 | `down` | death, die, knockdown, get up, kip up, kneel |
| 表演 | `emote` | victory, taunt, dance, wave, talk, roar, draw, sheathe |
| 其他 | `other` | anything unmatched |

- **First match wins**, in a fixed priority: a `导演__` source prefix → 表演; guarded locomotion (`Walk_Block`) → 移动; guard/block plus hit → 防御; then 倒地, 受击, 技能, 防御, 待机, 攻击, 跳跃, 表演, 移动, 其他.
- **Extra metadata.** `classifyAction` also returns a Chinese label, a cleaned English title, a loop guess and tags: `loop`, `in-place` (`__IP` suffix), `root-motion` (`__RM`), `transition` (`A_to_B`), `combat`, `pose` (duration < 0.1 s), `guard`, `fast`, directions, and `explore` / `cinematic` for `探索__` / `导演__` prefixes.
- **Order.** Cards sort by category, then plain loops, then variants, with single-frame poses last. Titles sort naturally, so numbers sort as numbers.
- **Search.** The search text covers the raw name, English title, Chinese label, category name in both languages, source tag and tags. It is case-insensitive.

A category says nothing about rig compatibility, quality, or whether the game uses the clip. An empty 攻击 chip does not mean the character cannot attack: check 其他 and the raw names before you tell the user. Never rename source clips to fix a category.

## Thumbnails and key poses

- Thumbnails are rendered in the browser on the *selected* character, not on the source model (`assets/viewer/thumbnail-studio.mjs`). One shared offscreen renderer works through a queue ordered by visibility and yields between jobs. It never touches the stage's pose, clips or selection. Portraits use the same cache.
- **Key pose.** The viewer samples 8–28 frames between 4% and 96% of the clip, with the hips locked horizontally, and picks by category: 待机 / 表演 at 40% of the duration; 倒地 at the lowest head; 跳跃 at the highest hips; 移动 at the widest foot spread; everything else at the frame where hands, feet and head sit furthest from their mean pose, with a slight preference for later frames. Clips of 0.05 s or less use frame 0. Attack, skill, move, defense and air cards longer than 0.25 s add faint ghost poses from earlier frames. Joints are found by name hints (hand, foot, head, hips) for framing only; that is not anatomical identity.
- For a matched action, the viewer reads curves through `POST /api/actions/curves`. The endpoint is read-only. It re-reads the exact source the scan indexed, registers nothing and does not touch `motion-library.json`. Body: `{assetId, slot, expectedModelSha, actionIds: [up to 12], samples?: 2–120}`. With `samples`, tracks are resampled at evenly spaced times (rotations re-normalised). Without it, the raw keys come back. Errors are reported per action, for example a stale list (`动作列表已更新，请重新选择`) or a changed source.
- A 常用 (saved) card resolves its recipe through `POST /api/motions/preview`, the same read-only call that plays it. Its key follows the recipe id, so a re-saved version gets a new thumbnail. Saved cards do not hover-preview.
- The cache lives in `<workspace>/cache/thumbnails/<key>.png|webp` and is served at `/workspace/thumbnails/<key>.<ext>`. Keys look like `<kind>-<32 hex>`: a SHA-256 over the thumbnail renderer version, the kind and the identities of what is depicted, so a new model or curve version gets a new key. The server accepts `[a-z0-9-]`, 8–96 characters. Files must be PNG or WebP and under 1 MB. `GET /api/thumbnails` lists the cache; `POST /api/thumbnails/<key>` stores one. The folder is git-ignored, and deleting it is always safe: thumbnails regenerate on the next view.
- A thumbnail is a visual index, not review evidence. Never cite it as a check or attach it to a job.

All POSTs need the `x-motion-token` header from `GET /api/session`.

## Play, adopt, prepare

| User step | What runs | What it writes |
|---|---|---|
| Hover a card | Mini preview from read-only curves | Thumbnail cache only |
| Tap a 匹配动作 card | `POST /api/actions/preview` / `motion_preview_available_action`. Re-checks the source fingerprint. A non-pack source is frozen as an immutable pack version for that one clip, then previewed with a pinned recipe. | A pack version in `motion-library.json`. No model head changes. |
| Adopt (shows under 常用) | `motion_adopt_action` with the preview's `recipe.id`. Only after an explicit user choice. | A character action record pinned to that recipe and source version |
| **修改这个动作** on a matched action | After a preview, `motion_prepare_action` materialises an independent candidate, archives the previous heads, then the normal task loop runs | New candidate head |
| **修改这个动作** on a 角色自带 action | The normal task loop on the character's current version | Task, then candidate |

`motion_prepare_action` refuses while the same model has a queued, running or needs-input task. Trial playback cannot be submitted as a task input. The full contract is in [separated-motion.md](separated-motion.md).

## Answer "what can character X do?"

1. Point the user to the 动作库 panel: select X in the 角色 rail, then browse by chip or search. Tapping a card plays it at once.
2. To answer in chat, list the characters with CLI `characters` (MCP `motion_list_characters`, `GET /api/characters`). Open X if it has not been opened (`open-character --asset-id ID`, MCP `motion_open_character`); the catalog needs an opened version.
3. Run `actions --workspace "$WORKSPACE" --asset-id ID` (MCP `motion_action_catalog {assetId, wait:true}`). It returns own and matched actions in one list with `origin`, `category`, Chinese `label`, `duration`, `loop` and, for matched rows, the `id` that `motion_preview_available_action` takes. Narrow with `--category attack` or `--query 连招`; add `--json` for the full object. The CLI waits for matching to finish (`--no-wait` lists own clips at once). Over MCP without `wait`, a `scanning` state means matching is still running in the server: read `scan.checked / scan.total` and ask again. The raw discovery rows stay at `GET /api/actions?assetId=ID` / MCP `motion_available_actions`.
4. Report counts per section (常用 / 角色自带 / 匹配动作) and group them by category, saying the categories are name-based. Mention a `partial` scan, the `incompatible` count (those clips need retargeting) and any preset variants.
5. Do not claim that the game uses a matched action, that it looks natural on X's proportions, or that it is adopted. "Compatible" means the bindings and rest pose match, nothing more.


## Advanced sources and keyboard navigation

**⋯ → 版本与来源** opens the current model's versions and selects the current slot. Its compact header retains the model context; 已收录动作、公共动作包、骨架映射 and 素材来源 are secondary tabs. The everyday 动作库 remains the entry for browsing actions.

`/` focuses the action search in 动作库 and opens the clip search in 修改. Inputs, IME and open dialogs own their keys. Arrow/Home/End keys navigate focused tablists before any frame-stepping shortcut. Narrow layouts expose 预览 / 动作 / 任务 / 记录 in a fixed navigation bar. 专注预览 expands the stage; Escape exits it.

## 返回与常用恢复

切换内置动作后用“返回上一动作”恢复观察；外部动作使用“结束试播”回到试播前。加入常用后，试播栏显示“移出常用”；素材详情的已收录动作也提供此入口。加入与移出均可在固定撤销栏或短暂提示中撤销，来源文件保留。
