---
name: motion-stage
description: Browse, inspect and improve 3D character models, rigs and animations in a project-linked local studio. Use for character action libraries, GLB/FBX motion preview, animation or deformation repair, candidate comparison, motion packs, and integrating approved edits into a game. Preserves frozen task context, drafts, source ownership and user decisions. Not for video editing, generating new models or automatic rigging.
---

# MotionStage · 动作台

A local character-animation studio with a version-bound task loop. Find the character and action, freeze the observation, build an isolated candidate, compare it with the actual input, and record the user's decision. Game integration is a separate requested action.

## Start and choose a route

Resolve `SKILL_DIR` to this folder. Reuse the workspace printed by the start command; do not create a fresh workspace to avoid an existing task or failed check.

```sh
node "$SKILL_DIR/scripts/start.mjs" --project "/absolute/path/game" --caller "$CALLER" --session "$SESSION"
node "$SKILL_DIR/scripts/start.mjs" --workspace "/absolute/path/review" --caller "$CALLER" --session "$SESSION" --no-open
```

Before launching, set `CALLER` to the actual invoking client (`codex`, `claude`, `workbuddy`, or another lowercase client slug), and `SESSION` to its current conversation identifier. If the host exposes no identifier, generate a dedicated routing ID once and retain it in this conversation; reuse it when reopening. Do not ask the user to supply these internals or infer the client from a model brand. A DeepSeek-backed WorkBuddy session uses `--caller workbuddy`; optional `--caller-model` records a known model without selecting or changing it. Omit the binding only when the client cannot be identified; the UI then says 当前对话. Do not reuse another conversation's bound server URL.

`--project` reuses `<project>/.motion-studio/`. A new standalone workspace includes the original teaching character. Runtime: Node.js 22+, WebGL2 for spatial previews; sampled curves also support Canvas2D. No npm install or model key. Blender 4.2+ is optional for FBX conversion; a configured Codex CLI, Claude Code or DeepSeek Harness is optional for background execution. These start independent tasks, not turns in the current chat. Workspaces belong outside the installed skill.

| Intent | Route | Read only the relevant reference |
|---|---|---|
| Browse / find / try actions | Select a character → 动作库 → action card; CLI `actions --asset-id ID` or MCP `motion_action_catalog` | [Action library](references/action-library.md) |
| Fix / tweak / compare | 修改 → frozen task → candidate → user review; follow the task loop below | [Agent workflow](references/agent-workflow.md) |
| Put an approved result into the game | `integrations` → inspect selected checkpoint/action and game → edit and verify → `integrate` | [Game integration](references/game-integration.md) |

The UI defaults to the invoking client’s conversation: save the task, copy its handoff, then the current agent reads and claims it. Saving does not wake a chat. **本机后台处理** scans known local executors and lets the user choose Codex CLI, Claude Code or DeepSeek Harness. The choice freezes as `job.provider`; each worker consumes only its own tasks. Discovery checks executable/version capabilities, not authentication, quota or tool permissions. Installed apps without a supported adapter stay disabled. Do not silently switch providers after a failed scan or execution. The automatic worker excludes tasks addressed to the current chat. Each chat task freezes `caller.client` and `caller.sessionId`; retries and replies retain that routing. A different client or session cannot claim it accidentally. This is routing metadata, not authentication. Existing tasks without `delivery` retain worker compatibility. Do not start a second consumer for a claimed task.

## Task loop

```sh
CLI="$SKILL_DIR/scripts/motion-feedback.mjs"
node "$CLI" jobs --workspace "$WORKSPACE"
node "$CLI" job --workspace "$WORKSPACE" --job "$ID"
node "$CLI" claim --workspace "$WORKSPACE" --job "$ID" --owner current-chat --caller "$CALLER" --session "$SESSION"
node "$CLI" progress --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --phase editing --message "正在调整左臂，保留腿部轨道。"
node "$CLI" motion-check --workspace "$WORKSPACE" --job "$ID" --file "$CANDIDATE_GLB"
node "$CLI" complete --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --candidate "$CANDIDATE_GLB" --summary "$SUMMARY" --audit "$AUDIT_JSON"
```

`job` returns a current-path `claimCommand`; use it only after confirming its caller matches this conversation. MCP `motion_claim_job` accepts `caller: {client, sessionId}`. Do not impersonate another caller to bypass a mismatch. For an unbound legacy task, omit the caller flags. Saving does not send a message or wake a host; claim directly when handling the submitted task in this conversation, otherwise present the copyable handoff. Do not report a live connection until execution actually begins.

`--audit` is optional. Keep the returned lease. MCP (`node "$SKILL_DIR/scripts/mcp.mjs" --workspace "$WORKSPACE"`) exposes the same task operations.

1. **Read the frozen evidence.** Read `task.md`, `context.json`, `view.png`, and `projectContextFile` returned by `job`. Use current `executionPaths` after a project move. Bind to `assetId`, the selected input slot and its SHA; the browser's current selection is irrelevant.
2. **Diagnose the responsible layer.** Animation, retargeting, skin, mesh/garment, attachment, timing, camera or runtime need different repairs. Inspect channels, hierarchy and native source; a screenshot or clicked influence alone is not a diagnosis. Use seconds, not assumed authoring frames.
3. **Resolve material ambiguity.** Character-left versus screen-left, conflicting preserve requirements or an unknown clip owner can require one specific question. Use `needs-input --error TEXT`; after `reply`, read the answer and claim again. Do not ask users for internal bone IDs or hashes.
4. **Build an isolated candidate.** Write into `executionPaths.outputDirectory`; preserve original bytes, other clips and out-of-scope data. Prefer the native authoring source when appropriate. Explicit swing-amplitude edits can use `editGlb` from `scripts/asset-tools.mjs`; it is a parameter transform, not a universal naturalness fix.
5. **Check proportionally.** Check the requested pose, meaningful extrema, interval/loop boundaries and protected data. For leg, arm or rotation edits, use job-bound `motion-check` above. It compares against this task's actual frozen input, including a previous candidate. Investigate **new and worsened** warnings; report improvements, skipped checks and limitations. Attach its result as `audit.motionChecks` (or the audit itself).
6. **Return and review.** Report real transitions (`reading`, `editing`, `checking`, `exporting`), then `complete`, `needs-input` or `fail`. Technical completion is distinct from user approval. While the user is following the task, the studio restores the frozen view; browsing or editing another draft is not interrupted. Side-by-side shows **修改前 on the left**, **修改后 on the right**. The user chooses **采用这版**, **继续调整**, or **不用这版**.

Completion records `candidateDiff` against the frozen input. If `lockOtherClips` is set, preserve every other clip and its tracks. A changed or unverifiable protected clip blocks acceptance; inspect the report and revise the candidate. The report covers animation data, while motion and deformation checks are separate.

For several changes in one clip, pause or scrub to each moment, select a body part when useful, then choose **标记当前画面** and save a short note. Submit the markers together. The main text field can describe an overall change or stay empty. Read every entry in `context.json.feedbackPoints`: each has its own time in seconds, target and camera. Use the marked pose to interpret the note and check adjacent motion; keep the task's shared scope and preservation requirements. Report the result for each mark by number. In the returned task, click each mark to compare the frozen input and candidate at that second and camera.

For an explicit signed angle and axis, `editGlb(input, {clip, bone, offset: {axis: 'x', degrees: -10}, start, end})` applies a rotation about the joint's own axis. Omit the range for the whole track. Use the frozen node index when available. The UI uses the same transform for **本地微调 → 旋转偏移 → 试播调整**. Inspect parent and descendant poses, especially if the instruction names a world direction or protects another part's world-space movement.

If requested to integrate a chosen result, continue through the integration route using its checkpoint/action ID. **接入游戏…** shows status and a concrete copyable handoff. Preserve the distinction between accepted preview and verified game integration; do not claim the latter without checking the game and recording it.

## Return, stop and undo

- **返回上一动作** restores the previous clip and observation in this browser session. **结束试播** restores the pre-trial clip, camera, time and playback state. Neither changes content history.
- **返回** keeps the edit draft. **取消排队 / 停止生成** cancels the task and invalidates its lease; late output cannot replace the current version. Never automatically restart a stopped task.
- **采用这版 / 继续调整 / 不用这版** are the three review choices. Keep game integration separate. **移出常用** removes only the saved choice, preserving sources.
- The fixed **撤销 / 重做** controls name the affected operation. Cmd/Ctrl+Z and Shift+Cmd/Ctrl+Z apply outside text fields; text fields retain native undo. Toast undo is an additional shortcut, never the only entry.
- Content history is per model, stored in `undo/<assetId>.json` (latest 50 operations). Adoption, rejection and common-action changes commit atomically with history. Redo reuses saved bytes, never starts an AI task. Source/head changes and active jobs block stale undo; a new content operation clears redo. A removed choice does not undo already integrated game files.
- When the user asks the agent to undo: read `undo-state --workspace PATH --asset-id ID`, verify its label matches the requested operation, then use `undo|redo --workspace PATH --asset-id ID --expected-revision N --entry ID`. MCP equivalents are `motion_undo_status` and `motion_undo`; do not skip later operations to reach an older choice. A mismatch needs clarification, not a guessed rollback.

## Invariants and recovery

- Read unknown project code and registries without executing them. Keep scanner rules project-neutral.
- Embedded clips belong to their model; external ownership requires registry or user evidence. Bone-name mapping is not retargeting. A skeleton-only FBX cannot demonstrate mesh deformation.
- `target.nodeIndex` identifies a node only within the frozen SHA; duplicate names must never redirect an edit. Composite characters require the selected clip's frozen owner/dependency.
- Trial playback is transient. Adopt only on user intent; prepare a separate working model when the user asks to edit a matched action. Preserve `source.motionBinding`. Publish shared packs only when requested.
- Keep version, source and parent task identities. A changed model revision/source invalidates a task; browsing does not. Same bytes do not establish lineage or permission to borrow another character's history. Preserve inherited constraints; completed historical goals are context.
- The completion gate checks lease, versions, file validity and retained clips. Never bypass it, overwrite source inputs, publish an unfinished candidate, or call an unchanged copy an improvement.
- Parent motion affects descendants in world space. Root locking and normalization must not hide root travel or scale defects. Reuse the studio for routine playback; extra rendering/import is justified by actual export risk or an explicit request.
- Optional check failure: record the limitation; allow **one** targeted retry only for a diagnosed transient failure with a concrete correction. Missing tools, denied access or unsupported formats do not justify repeated attempts or building another verification pipeline. Required authoring tools and failed necessary checks still block completion.
- Joint measurements do not prove naturalness, mesh collision freedom, cloth, runtime IK or gameplay blending. Say precisely what was checked and what remains.
- Drafts live in `drafts/<assetId>.json`, survive new ports and move with the workspace. Local browser storage is fallback. Concurrent edits require an explicit conflict choice; do not overwrite another window silently. Stale loading responses cannot replace the current model or its draft.

Delivery: give the local URL, addressed task and candidate/evidence paths, what changed, checks and remaining limits. When editing this skill's UI, regression-test affected contracts and inspect actual desktop and narrow-screen layouts; a source review alone is not visual acceptance.

## Supporting references

| Need | Reference |
|---|---|
| Packs, mappings, preview → adopt → prepare | [Separated motion](references/separated-motion.md) |
| Character declarations and clip ownership | [Character map](references/character-map.md) |
| Import formats, capabilities, identity | [Asset library](references/asset-library.md) |
| Project linking, context, history continuity | [Project workspace](references/project-workspace.md) |
| Game shading adapters | [Project appearance](references/project-appearance.md) |
| Install and user troubleshooting | [Setup](references/setup.md) |
| Diagnostics, interrupted tasks, retry and restore | [Reliability](references/reliability.md) |
| Recorded case studies | [Agent case](references/agent-case.md), [Real case](references/real-case.md) |
