---
name: motion-stage
description: Local 3D character animation studio for game projects with GLB/FBX assets. Browse a project's characters and every action each rig can play (rendered thumbnails, compatible actions auto-matched across the project), try another file's action on a character, compare candidates, and fix or tweak animations through a reviewed agent task loop. Use for 3D character models, rigs and animations, e.g. 动作库, 角色动作预览, 这个角色能做哪些动作, 给角色找动作, 试试别的角色的动作, 修动作, 动作不自然, 脚底打滑, 摆臂太大, 手臂穿模, 对比修改前后, motion packs and bone-name mappings, or previewing with the game's shading. Not for general video editing, generating or auto-rigging new 3D models (use tripo-character), or downloading new mocap (use mixamo-motion).
---

# MotionStage · 动作台

3D 角色动作工作台 · 3D character animation studio

A local browser studio plus an agent task loop. The studio plays every action on the real rig, captures each request with exact seconds, camera, selection and screenshot, and compares candidate with original. You read that frozen evidence, diagnose the responsible layer and author the repair in an isolated job directory. The user decides. A preview, even an accepted one, is not game integration.

## Quick start

Resolve `SKILL_DIR` to this folder.

```sh
node "$SKILL_DIR/scripts/start.mjs" --project "/absolute/path/game"       # creates/reuses <project>/.motion-studio/
node "$SKILL_DIR/scripts/start.mjs" --workspace "/absolute/path/review"  # loose files, outside the installed skill
# add --no-open to print the URL instead of opening a browser
node "$SKILL_DIR/scripts/motion-feedback.mjs" add --workspace "$WORKSPACE" --slot baseline --file "$MODEL" --new-model  # import GLB/FBX/JSON
```

Loopback server on a free port; only a new workspace gets the teaching scene. Users can double-click `Open MotionStage.command` / `.cmd`. Needs Node.js 22+ and WebGL2 (sampled curves fall back to Canvas2D). Optional: Blender 4.2+ for FBX, a logged-in Codex CLI for the automatic worker. No npm install or model key. `$WORKSPACE` is the workspace the start command prints.

## Route the request

| User wants | Do | Read |
|---|---|---|
| See a character's actions (看角色动作) | Select it in the 角色 rail, 动作库 mode | [action-library](references/action-library.md) |
| "Which actions fit X?" (给角色找动作) | CLI `actions --asset-id ID` / MCP `motion_action_catalog` (categorized, read-only) | [action-library](references/action-library.md) |
| Try a shared or other character's action | Tap its 匹配动作 card; adopt only on request | [action-library](references/action-library.md), [separated-motion](references/separated-motion.md) |
| Reusable motion packs, name mappings | `motion_register_pack`, `motion_save_rig_mapping` | [separated-motion](references/separated-motion.md) |
| Declare a character's models and motions | Read the registry read-only, save `character-map.json` | [character-map](references/character-map.md) |
| Fix or tweak an action (修动作) | Task loop below | [agent-workflow](references/agent-workflow.md) |
| Match game shading | Workspace adapter + `appearance-install` | [project-appearance](references/project-appearance.md) |
| Import GLB / FBX / sampled JSON | **＋导入**, or CLI `add` (Quick start) | [setup](references/setup.md), [asset-library](references/asset-library.md) |
| Environment, upgrade, recovery, retry | `doctor`, `motion_diagnostics`, **⋯ → 环境检查** | [reliability](references/reliability.md) |
| Link a project, continue earlier fixes | Project switcher or `--project` | [project-workspace](references/project-workspace.md) |

## The studio at a glance

- **Top bar:** project switcher · **动作库** (browse, preview) / **修改** (request changes, follow the task, compare candidate vs original) · **修改记录** · **＋导入** · **⋯** → **版本与来源**, **项目文件**, **环境检查**, **使用帮助**.
- **角色 rail** (left): project characters as rendered portraits. **全部角色** also lists the project's other skinned models.
- **动作库 panel** (right): every action the character can play, as cards rendered *on that character* at an automatic key pose. **常用** adopted · **角色自带** embedded + declared · **匹配动作** found across the project (same rest pose and hierarchy, exact duplicates removed). Chips **全部/待机/移动/攻击/技能/防御/受击/跳跃/倒地/表演/其他** come from `assets/viewer/action-taxonomy.mjs`: name-based hints only. Search covers Chinese label, English title, raw clip name. Tap plays, hover previews, **修改这个动作** opens 修改 on it.
- Thumbnails render in the browser into `$WORKSPACE/cache/thumbnails/` (safe to delete) from read-only curves and register nothing. Only explicit play / adopt / prepare enters preview → adopt → prepare.
- **视角与显示 → 角色外观** defaults to **中性检查**.

| Endpoint (POST needs `x-motion-token` from `GET /api/session`) | Returns |
|---|---|
| `GET /api/cast` | Characters, declared first, with portrait sources |
| `GET /api/characters/<id>/model` | Main model bytes of a declared GLB character |
| `GET /api/actions?assetId=&slot=&expectedModelSha=` | Matched-action scan state and rows |
| `POST /api/actions/curves` | Read-only curves for up to 12 matched actions |
| `GET /api/thumbnails` · `POST /api/thumbnails/<key>` | Thumbnail cache |

Agents read the same catalog without the browser: `node "$SKILL_DIR/scripts/motion-feedback.mjs" actions --workspace "$WORKSPACE" [--asset-id ID] [--category attack] [--query 连招] [--json]`, or MCP `motion_action_catalog` (`wait:true` to finish matching). It lists own and matched actions with category, Chinese label, duration and loop hint, and adopts nothing. Match results persist in `$WORKSPACE/cache/actions/` (safe to delete), so repeat runs return in well under a second. The raw scan stays at `motion_available_actions` / `GET /api/actions`.

## Task loop

```sh
CLI="$SKILL_DIR/scripts/motion-feedback.mjs"
node "$CLI" jobs  --workspace "$WORKSPACE"                  # one summary per task; --full for every field
node "$CLI" job   --workspace "$WORKSPACE" --job "$ID"
node "$CLI" claim --workspace "$WORKSPACE" --job "$ID" --owner claude-code   # keep the lease
node "$CLI" progress --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --phase editing --message "正在收小左上臂摆幅，保留其他轨道。"
node "$CLI" complete --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --candidate "$CANDIDATE_GLB" --summary "$SUMMARY"
node "$CLI" needs-input --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --error "具体的问题"   # or fail
```

1. **Read** `task.md`, `context.json`, `view.png` and the `projectContextFile` that `job` returns. `--owner` only records who claimed.
2. **Inspect** with `inspect --asset-id` bound to the job's `assetId` and frozen SHA, not the browser selection. Prefer a native authoring source; a GLB lacks IK controls, cloth and engine layers.
3. **Diagnose** the layer (animation, retargeting, skin, mesh/garment, attachment, timing, camera, runtime). Resolve character-left vs screen-left or clip vs interval via `needs-input`.
4. **Build** in `executionPaths.outputDirectory`. Swing edits: `editGlb(bytes,{clip,bone,factor,start,end})` and `inspectAsset(bytes)` in `scripts/asset-tools.mjs`. Otherwise Blender or the project pipeline.
5. **Progress** at real transitions: `reading`, `editing`, `checking`, `exporting`.
6. **Check** with `motion-check` (input vs candidate) when legs, arms or rotations change.
7. **Return** with `complete` (optional `--audit FILE`), or `needs-input` / `fail` with a specific `--error`. After `reply`, read the clarification and claim again.

MCP (`node "$SKILL_DIR/scripts/mcp.mjs" --workspace "$WORKSPACE"`) mirrors this: `motion_list_jobs`, `motion_get_job`, `motion_claim_job`, `motion_inspect_asset`, `motion_report_progress`, `motion_check_motion`, `motion_complete_job`, `motion_fail_job`, `motion_reply_job`. Optional worker: **连接 Codex 并开始修改** or `worker --workspace PATH [--once]` runs the user's logged-in Codex CLI per job on their own account. Neither is required.

## Guardrails

- Never execute unknown project code during discovery, context or appearance review; read registries read-only; add no project-specific scanner rules.
- Embedded clips belong to their model. Names or bone-name matches never make an external motion a character's; only the project registry or the user does.
- Incompatible rigs need an explicit retargeting task. Name mapping is not retargeting; conversion fixes no skeleton. A skeleton-only FBX shows no deformation: ask for a With Skin download or a retarget task.
- A clicked influence is a hint. Within a frozen SHA `target.nodeIndex` is the node; duplicate names never redirect to another rig.
- Trial playback is transient, never a task input. `motion_adopt_action` only on explicit user adoption; `motion_prepare_action` only when the user wants to edit. Keep `source.motionBinding`. Publish to a public pack only if asked.
- Preserve source/version identities, clip provenance and frozen dependencies. Only **载入源文件新版本** adopts source changes. A new head revision or confirmed source change invalidates a task; browsing does not. Never borrow another model's history for matching bytes.
- Build only in the job directory. Never edit project files until the user asks for game integration.
- Completion refuses stale identities: never override. A clarification cannot adopt changed sources; start a fresh task.
- No fake percentages, reasoning or raw output in progress. Never call an unchanged copy an improvement. Never run `practice` on private models.
- Carry earlier preserve clauses; completed goals and AI summaries are background; the current explicit request wins; ask about conflicts. Candidate evidence is not a confirmed mapping; older sources may need edits replayed. Use current `executionPaths` after a move.
- The user decides keep, revise or accept. Only user decisions create checkpoints; completion is never artistic approval.
- Never infer game appearance from a GLB alone or alter source textures for preview lighting. Game-specific code stays in the workspace, never in this skill.
- Keep teaching assets, private test assets and historical cases distinct.
- Tool detection proves no login, quota or GPU. Keep pending transaction logs. Stop older studio versions before upgrading a workspace.

## Verify and report

- Check proportionally: requested pose, extrema, scope and loop boundaries, protected data. No routine sweeps of thousands of poses. Parent changes move descendants in world space; root locking and normalisation must not hide root-motion or scale defects.
- Run `motion-check` on input and candidate together; report `new` findings. Evidence, not a gate.
- Reuse the studio for playback: no extra renderer, video, player or importer for routine GLB edits. Bake or fresh-import only when export risk warrants it or the user asks.
- Record a failed optional check once and return the candidate; no retries or substitutes. Missing required tools or failed necessary checks still block.
- Numbers prove neither naturalness nor collision freedom. A GLB cannot validate DQ, cloth, gameplay transitions, terrain IK or custom shaders; inspect the game when asked.
- Report the local URL, candidate and evidence paths, source identity, task addressed, checks run and remaining limits. Ask the user to compare in 修改 mode and decide.

## References

- [action-library](references/action-library.md): 动作库, discovery, categories, thumbnails, "what can X do?"
- [agent-workflow](references/agent-workflow.md): task loop in depth, motion checks, completion gate, compare and decide
- [separated-motion](references/separated-motion.md): packs, mappings, preview → adopt → prepare contract
- [character-map](references/character-map.md): declaring characters, ownership, composite previews
- [asset-library](references/asset-library.md): scanning, formats, capabilities, identities
- [project-workspace](references/project-workspace.md): project linking, layout, context packets, continuity
- [project-appearance](references/project-appearance.md): game-shading adapters
- [setup](references/setup.md): install, import formats, user troubleshooting
- [reliability](references/reliability.md): diagnostics, recovery, interrupt/retry/restore, validation scope
- [agent-case](references/agent-case.md) / [real-case](references/real-case.md): measured round trips; a real rejected edit and rollback
