---
name: motion-stage
description: Inspect and improve 3D models, rigs and animations in a project-linked local studio, with scoped code/source context, preserved user feedback, accepted checkpoints and candidate comparison. Use for motion or deformation review and continuous character fixes; not for general video editing.
---

# MotionStage · 动作台

3D 模型与动画工作台 · 3D model & animation studio

Help the user point at an observed pose or surface, describe the desired change in ordinary language, and compare a verified candidate. The studio supplies evidence and version context; the agent diagnoses and authors the actual repair. An accepted preview is separate from production game installation.

## Open the studio

Resolve `SKILL_DIR` to this folder. When the game project is clear, prefer `node "$SKILL_DIR/scripts/start.mjs" --project "/absolute/path/game"`; it creates/reuses `.motion-studio/` in that project. A loose-file review can use Node.js 22+ and an absolute workspace outside the installed skill:

```sh
node "$SKILL_DIR/scripts/start.mjs" --workspace "/absolute/path/motion-review"
```

This creates the original teaching scene only when the workspace is new, starts a loopback server on a free port and opens the browser. `--no-open` prints the URL. Users can also double-click the bundled macOS `.command` or Windows `.cmd` launcher. The offline viewer and parameter edits need no npm install or model key. Spatial previews require WebGL2; sampled-curve inspection uses Canvas2D and remains available without it. FBX intake additionally needs local Blender 4.2+.

Selecting a project folder recursively indexes resources without loading all geometry. **项目资源库** prefers confirmed character mappings when present; otherwise it shows **全部资源**. Mesh, hierarchy, joints, skin, node/morph animation and raw curves are independent capabilities. Static models, standalone skeleton/node animations and sampled-motion JSON can open independently. Empty containers show metadata; unsupported formats remain visible as source files. Embedded clips belong to their model. External motions need an explicit association supported by the actual project registry or a user choice; names and matching bone names alone do not establish ownership. For separated assets, read [asset-library.md](references/asset-library.md), inspect the project's asset registry read-only, and save a declarative `character-map.json` in the workspace. Do not execute unknown project code or add project-specific rules to the scanner.

Opening a character composes an owned preview from confirmed sources, checking node bindings, rest transforms and hierarchy for external GLB clips. Unsupported or incompatible sources stay visible while usable clips return. The studio preserves clip provenance, frozen dependencies, independent candidates and task histories. **载入源文件新版本** explicitly adopts source changes and archives prior versions; refreshing the directory only discovers changes. Runtime IK, cloth, procedural layers and arbitrary engine/private formats require the corresponding authoring or export workflow.

**视角与显示 → 角色外观** defaults to **中性检查**. When the user asks to match game shading, read [project-appearance.md](references/project-appearance.md): review the project's character shaders and stable post-processing, build a workspace-owned adapter, and explicitly register it with `appearance-install`. Project mode imports only the registered snapshot and checks renderer compatibility; optional failures rebuild a clean neutral pair. Do not infer game appearance from GLB alone, execute arbitrary project modules during discovery, or change source textures to compensate for preview lighting. Game-specific code stays outside this distributable Skill.

Use **导入素材** to add an independent GLB, FBX or sampled-motion JSON resource to the workspace. Or:

```sh
node "$SKILL_DIR/scripts/motion-feedback.mjs" add --workspace "$WORKSPACE" --slot baseline --file "$MODEL" --new-model
```

Static GLB can be inspected. A skeleton-only FBX cannot show character deformation by itself; request a With Skin download for that same character or an explicit retargeting task with the necessary sources. Do not pretend file conversion solves incompatible skeletons. See [setup.md](references/setup.md) for installation and formats.

Use CLI `doctor`, MCP `motion_diagnostics`, or `/api/doctor` when an environment lacks an optional tool. Executable detection does not verify account login, quota or browser graphics. For upgrades, dependency paths, interrupted commits, draft persistence limits and the actual support matrix, read [reliability.md](references/reliability.md). Preserve pending transaction logs; normal metadata APIs recover before reading. Stop older studio versions before using an upgraded version on the same workspace.

Startup checks Node and an owned temporary write/rename/read/cleanup in the workspace, then actually binds the loopback server. Optional programs are checked when importing FBX or connecting Codex, not during normal startup/polling. **环境检查** shows cached startup results and the real browser renderer status; **重新检查** explicitly refreshes the workspace and optional program versions. Missing optional tools leave GLB viewing and local edits available.

## Shared motion asset workflow

The Asset Studio (资产中心) separates model versions, immutable public motion packs, reviewed name mappings and adopted character actions. Read [separated-motion.md](references/separated-motion.md) before registering, previewing or preparing a shared action. Prefer this workflow for trying a reusable motion on a character; the earlier character-map composite flow remains available for existing project declarations.

Use `motion_asset_library` / CLI `motion-library` to inspect identities. `motion_register_pack` extracts reference nodes and animation curves without meshes, skins or materials. `motion_rig_options` exposes the two node sets; `motion_save_rig_mapping` accepts only an explicit name mapping that passes reference-pose and hierarchy checks. `motion_preview_binding` changes no model heads. Only an explicit user adoption should call `motion_adopt_action`; pin its preview recipe and source version. `motion_prepare_action` materializes an independent candidate only when the user wants to edit that action. It archives previous heads and refuses an active task on the same model. Then create/claim the normal editing task on the resulting candidate. Preserve `source.motionBinding` provenance. Do not publish a character-specific edit into a public pack unless the user explicitly requests that scope.

Trial playback is transient and cannot be submitted as a canonical editing task. Preparing or exporting always revalidates immutable inputs. Name mapping is not arbitrary retargeting; changed rest poses, incompatible roots, missing bones and mesh-specific morph tracks require their appropriate authoring workflow.

## Link project context and preserve continuity

The project selector is a one-time association; recent projects resume on later launches. Current loose-file records can be copied into the project's owned workspace, while switching two linked projects never mixes their records. Use [project-workspace.md](references/project-workspace.md) for the workspace layout, provenance, migration and CLI details.

Every new task freezes a project/context packet with relevant code, authoring sources and historical references, plus exact parent lineage and user acceptance records. Read `projectContextFile` from `job`, `project-context --job ID`, or MCP `motion_project_context`. Evidence marked candidate is not a confirmed native-source mapping. An older source may need prior edits replayed; it is not automatically synchronized with the selected GLB.

Carry applicable earlier preserve clauses and inspect original requests/clarifications for implicit constraints. Completed goals and AI summaries are background, not instructions to apply again. Respect current explicit user changes and ask about material conflicts or ambiguous branches. Only actual user decisions establish accepted checkpoints. Compare each output against its actual input, and verify protected properties separately.

Source/project drift makes the task stale. A clarification cannot silently adopt changed source files. Outputs and native/code patches stay in the task directory; project files remain untouched until an explicitly requested game integration. Use current `executionPaths` after a project move, not absolute paths embedded in old evidence.

## Receive the user's intent

Let the user pause, click a body region, select a time interval and write one request. Do not require bone names or separate observation/expectation/acceptance essays. The studio records version, clip seconds, camera, playback conditions, selection and screenshot. A picked influence is a hint, not confirmed anatomical identity. Within a frozen asset SHA, `target.nodeIndex` identifies the actual node; duplicate names are labels and must never redirect a selection or edit to another rig. Resolve material ambiguity such as character-left versus screen-left, whole clip versus a local interval, or a missing reference.

Keep visual observations separate from inferred causes. Diagnose animation, retargeting, skin, mesh/garment, attachment, timing, camera or runtime ownership before editing. Read [agent-workflow.md](references/agent-workflow.md) for connection modes, source-time mapping and edit decisions.

## Process an explicit task

**Current chat / any compatible agent:** inspect queued tasks through the CLI or the bundled stdio MCP. No second model service is required:

```sh
node "$SKILL_DIR/scripts/motion-feedback.mjs" jobs --workspace "$WORKSPACE"
node "$SKILL_DIR/scripts/motion-feedback.mjs" job --workspace "$WORKSPACE" --job "$ID"
node "$SKILL_DIR/scripts/motion-feedback.mjs" claim --workspace "$WORKSPACE" --job "$ID" --owner agent
```

`--owner` only records who claimed the task; use your agent's name, for example `claude-code` or `codex`.

Read the returned task/context packet and screenshot; retain the claim lease. Use `inspect` or `motion_inspect_asset` to read actual rig/mesh/channel data. Prefer a native authoring source when present; ordinary GLB lacks the original IK controls, cloth solver and engine layers.

Bind inspection and edits to the job's `assetId` and frozen input SHA. CLI `inspect --asset-id ID` and MCP `motion_inspect_asset` accept the model identity; the current browser selection may belong to another task. Browsing another model does not invalidate this task. A changed head revision or confirmed production source still does. Return results to the job; never switch a different model's preview or borrow its history merely because two files share the same bytes.

Build into the job's private output directory. Preserve input bytes and scope-external data. For explicit quaternion swing-amplitude edits, `scripts/asset-tools.mjs` exports `editGlb(bytes,{clip,bone,factor,start,end})` and `inspectAsset(bytes)`; it reports unsupported tracks rather than corrupting them. Other repairs use the appropriate Blender or project source pipeline. Never call the teaching `practice` command on private models.

Report meaningful execution transitions while the task is running, using a concise user-facing message and the claim lease:

```sh
node "$SKILL_DIR/scripts/motion-feedback.mjs" progress --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --phase editing --message "正在收小左上臂摆幅，保留其他轨道。"
```

Phases are `reading`, `editing`, `checking`, `exporting`; report only the actual stage. The MCP equivalent is `motion_report_progress`. Never invent a percentage or expose reasoning, raw commands or tool output in the visible progress message. The automatic worker also observes real command activity, and reads its job-local `agent-output/progress.json` for explicit stage reports. A user clarification can resume a `needs-input` task through `reply` / `motion_reply_job`; read the appended clarification before re-executing.

Return the actual candidate with a concrete summary. Attach a short audit of actual task-specific checks when available; the optional report does not gate completion:

```sh
node "$SKILL_DIR/scripts/motion-feedback.mjs" complete --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --candidate "$CANDIDATE_GLB" --summary "$SUMMARY"
```

Use `needs-input` or `fail` with the lease and a specific `--error` when blocked. Completion refuses stale source identities; do not override that guard. Do not label unchanged copies as improvements.

**Optional automatic worker:** the user may explicitly select **连接 Codex 并开始修改**. The installed/logged-in Codex CLI then handles submitted tasks in separate writable job directories, using the user's configured model and normal account usage. Errors and clarification requests stay visible. The studio does not silently awaken the current chat. `worker --workspace PATH [--once]` is the CLI equivalent.

**Optional MCP:** launch `node "$SKILL_DIR/scripts/mcp.mjs" --workspace "$WORKSPACE"` through a stdio-capable host, or use `motion-feedback.mjs mcp`. Tools cover task list/read/claim/complete/fail/cancel and asset inspection. A current-chat workflow remains valid without MCP or a background worker.

## Verify and decide

Use lightweight verification proportional to the repair. Check the requested pose, relevant extrema, scope/loop boundaries and protected data; choose samples for this task rather than routinely sweeping thousands of poses. Descendants move in world space when a parent bone changes even if their local curves do not. Root locking and display normalization must not hide a root-motion or scale defect.

Completion enforces current input identity and necessary candidate-file checks in code. Reuse the studio for user playback and comparison. Routine GLB curve edits need no separate renderer, comparison video, external player or independent importer. Bake/fresh-import only when the actual authoring/export risk warrants it or the user requests deeper validation. If an optional verification tool is unavailable or fails, record the limitation once and return the ready candidate; do not retry or construct a substitute verification pipeline. Required authoring tools and failed necessary checks still block completion. See [agent-workflow.md](references/agent-workflow.md) for the check boundary.

Report actual sampling, checked sources and remaining limits. Numeric samples do not prove naturalness or continuous collision freedom. The studio cannot validate runtime DQ, real-time cloth, gameplay transitions, terrain IK or custom shaders from a plain GLB; inspect the actual game when that is part of the request.

The user decides whether to keep, revise or accept. Technical completion never invents artistic approval. Return the local URL, candidate and evidence paths, source identity, addressed task, checks and remaining limits. See [feedback.md](references/feedback.md) for feedback semantics, [agent-case.md](references/agent-case.md) for the measured live Codex and Claude Code round trips, and [real-case.md](references/real-case.md) for the authentic rejected edit and rollback. Original teaching assets, private test assets and historical cases must remain distinguishable.
