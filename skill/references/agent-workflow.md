# Task loop · agent execution and evidence

The studio is a feedback client. Reading a selection or saving a note does not start a model turn. A submitted task is durable, with frozen baseline and candidate identities. Its state is authoritative; the UI never invents progress.

This file covers the whole loop: connection → what a task carries → reading the request → claim → progress → inspect → build → check → return → compare and decide. Continuity rules across tasks live in [project-workspace.md](project-workspace.md). Queueing, interruption, retry and checkpoint restore live in [reliability.md](reliability.md).

## Choose the connection

- **Current chat:** read queued tasks through the CLI or stdio MCP. Claim one, inspect its task/context packet and actual source, build an isolated candidate, then complete with the lease. The current chat's installed tools remain available. This route does not require another model API key or a background worker.
- **Local Codex worker:** the user explicitly connects the locally installed, logged-in Codex CLI (**连接 Codex 并开始修改** in 修改 mode, or `worker --workspace PATH [--once]`). It starts separate non-interactive Codex turns using the user's configured model, with a per-job writable output directory. It consumes that account's normal usage. The worker checks final output and current versions before publishing a candidate. Errors and clarification requests stay visible. Disconnect/cancel stops further execution. No new key is requested in chat. The studio never silently wakes the current chat.
- **Other assistants:** use the same CLI/MCP task contract. A Claude worker is not bundled. Do not describe a queued task as having reached a running agent without a real consumer.
- **MCP:** launch `node "$SKILL_DIR/scripts/mcp.mjs" --workspace "$WORKSPACE"` from a stdio-capable host, or `motion-feedback.mjs mcp --workspace PATH`. The tools cover task list/read/claim/progress/reply/complete/fail/cancel, asset inspection, motion checks, actions and diagnostics. The current-chat CLI route stays valid without MCP.
- **Local parameter edit:** an explicitly named bone, clip, time scope and swing factor can be applied by the deterministic animation-data tool (`local-edit --workspace PATH --job ID --bone NAME --factor 0.7`). This is a parameter transformation, not an AI artistic judgment or a universal naturalness fix.

## What a task carries

Users only pause, point at the body and say in their own words how it should change. Never ask them for bone names, asset SHAs, coordinates, or separate observation/expectation/acceptance write-ups. "跑步时左手挤向腰部，正面看粘成一块，希望稍微张开，其他肢体保持" is enough to start diagnosing.

On submit the page saves: the file identities of original and candidate, the viewed version, clip name, exact seconds, review FPS and frame index, scope interval, body part, camera, display mode, scale normalisation and in-place preview transform, plus the PNG screenshot. A bone inferred from a click is a hint; the user can confirm it in the part dropdown. It is not a diagnosis and not confirmed anatomical identity. Review FPS is the stepping unit, not the source sample rate. FBX conversion additionally saves the source frame ↔ seconds mapping.

Within a frozen asset SHA, `target.nodeIndex` identifies the actual node. Duplicate names are labels only and must never redirect a selection or edit to another rig. See [asset-library.md](asset-library.md) for node indices across re-exports.

A task freezes both input versions. If the assets change, the old task's result is marked stale and refused. History comparison loads that task's own archived models; return to the current assets before submitting a new task. A model has at most one queued, running or needs-input task at a time; a duplicate submit keeps the browser draft. Different models queue independently.

## Read the request

Separate observation, goal, diagnosis and acceptance. Never write a guess as the user's words. Keep visual observations apart from inferred causes.

Resolve material ambiguity before editing: character-left versus screen-left, the whole clip versus a local interval, a missing reference. Preserve clauses are optional. When a missing condition would change the result, ask one specific question and mark the task `needs-input`.

"收一点摆臂" does not automatically mean an arbitrary 30% transform. Without a number, propose a moderate candidate and state the basis. Use the strict swing-factor tool only when the user explicitly chose local fine-tuning or the request genuinely fits it. It is a deterministic transform; it does not fix foot slide, balance or intersection.

For a follow-up task, carry the applicable earlier preserve clauses and read the original requests and clarifications for implicit constraints. Completed goals and AI summaries are background, not instructions to repeat. Current explicit user changes win; ask about material conflicts or ambiguous branches. Details: [project-workspace.md](project-workspace.md).

## Claim and bind

```sh
node "$SKILL_DIR/scripts/motion-feedback.mjs" jobs --workspace "$WORKSPACE"
node "$SKILL_DIR/scripts/motion-feedback.mjs" job --workspace "$WORKSPACE" --job "$ID"
node "$SKILL_DIR/scripts/motion-feedback.mjs" claim --workspace "$WORKSPACE" --job "$ID" --owner claude-code
```

`--owner` only records who claimed the task. Keep the returned lease for every later call. If a worker already claimed the task, use its lease; do not claim again.

Bind every inspection and edit to the job's `assetId` and frozen input SHA. CLI `inspect --asset-id ID` and MCP `motion_inspect_asset` accept the model identity. The current browser selection may belong to another task. Browsing another model does not invalidate this task; a changed head revision or a confirmed production-source change does. Return results to this job. Never switch a different model's preview or borrow its history because two files share the same bytes.

Use the current `executionPaths` from `job` after a project move, not absolute paths embedded in old evidence.

## Explain actual progress

Once claimed, report the stage as it changes with `progress --workspace PATH --job ID --lease TOKEN --phase PHASE --message TEXT`, or `motion_report_progress`. The four stages are `reading`, `editing`, `checking`, `exporting`. A stage may return to editing when a check exposes another issue. A stage label does not prove every preceding check passed.

Messages should tell the user what is happening to their model in one short sentence. Report real operations and results; do not invent percentages, remaining time or artistic acceptance. CLI command start/end events update recent activity without guessing a stage. The worker surfaces only user-visible messages, never reasoning or raw command/output bodies. Its job-local `progress.json` accepts `{ "phase": "checking", "message": "正在核对未修改的腿部与根运动。" }`; overwrite atomically at meaningful transitions.

The studio displays elapsed time and time since last activity. Silence means no new progress was reported; it does not imply the model is stuck or that another stage has completed. Cancellation invalidates the lease, so a late process cannot overwrite status or deliver a candidate.

If clarification is needed, fail with `needs-input` and a specific question. The user can answer directly in the task panel. `reply --job ID --message TEXT` / `motion_reply_job` records the answer in task/context and queues the same version-bound task again. Read the appended clarification before re-executing. Reclaim returns a new lease; the worker clears old stage files for the new attempt. If assets changed, the reply is refused as stale; start a fresh task on the current source.

## Inspect before modifying

Read `task.md` and `context.json` in the job folder, the frozen screenshot `view.png`, and the project context (`projectContextFile` from `job`, `project-context --job ID`, or MCP `motion_project_context`). Verify asset SHA, clip, selection, time range, playback mode and model-to-view transforms. Seconds are the primary time reference. `round(time * reviewFPS)` is a review index, not a source Blender frame. FBX intake records source FPS and first frame; retiming can require a nonlinear mapping.

Use asset inspection to read the relevant skeleton hierarchy, rest transforms, skin influences and animation channels. A screenshot cannot establish bone identity, mesh topology, contact anchors or the cause of a deformation. Selecting a surface provides a mesh and influence hint; the user or agent must confirm the intended semantic target.

Diagnose the responsible layer — animation, retargeting, skin, mesh/garment, attachment, timing, camera or runtime — before editing:

| Observation | Inspect | Likely operation |
|---|---|---|
| Excessive limb swing | Quaternion/Euler channels and scope | Scoped curve edit |
| Wrist should reach a point | Shoulder/elbow chain, reach and grip | IK/constraint solve and bake |
| Shoulder collapses on bending | Weights, joint shape, corrective shapes | Skin or geometry repair |
| Motion twists after transfer | Rest pose, axes, scale, mapping | Explicit retarget and bake |
| Feet slide | Contact phases, root travel and controller speed | Timing/root/IK or runtime repair |
| Sleeve intersects torso | Garment shape, weights, motion and cloth ownership | Repair the responsible layer and rebake affected caches |

Prefer a native authoring source when the project has one. A plain GLB/FBX may lack the original controls, constraints or garment solver. State that missing source rather than recreating an unrelated rig. The viewer does not reproduce engine shaders, runtime cloth, DQ corrections, controller movement, gameplay blending or terrain IK.

## Build and return

Build into the job's private output directory (`executionPaths.outputDirectory`). Preserve the immutable input bytes and all data outside the scope. Author an isolated candidate and a reproducible script or edit recipe. Constrain changed bones, channels and time interval. Changing an upper-arm transform moves its descendants in world space; distinguish unchanged local curves from unchanged world positions. Do not compensate for a skinning defect by changing an approved motion without evidence.

For an explicit quaternion swing-amplitude edit, `scripts/asset-tools.mjs` exports `editGlb(bytes, {clip, bone, factor, start, end})` and `inspectAsset(bytes)`. It reports unsupported tracks (compressed, STEP, CUBICSPLINE, missing) instead of corrupting them. Other repairs use Blender or the project's own source pipeline. Never run the teaching `practice` command on private models; it is only for the bundled original practice character.

For a composite character, first resolve the selected clip through `job.source.assembly.clips[clip]` and read the frozen dependency SHA. An embedded clip, exploration GLB and sampled director pack may have different authoring owners. Fix the actual owner when a production-source change is requested; do not edit a similarly named embedded clip and claim the external override changed. A returned composite GLB is a review candidate; native game integration still needs the corresponding source change and runtime check.

Compare each output against its actual input, not the first upload, and verify protected properties separately. Verify the requested change and relevant preserved data with the smallest useful checks. For a curve edit, inspect the captured pose, relevant extrema and scope/loop boundaries, using the same seconds and transforms as the task. Increase sampling only when the repair's risk requires it. Do not routinely sweep thousands of poses. Root locking and display normalisation must not hide a root-motion or scale defect. Keep the short audit honest about what was sampled; it is not a proof of continuous collision freedom or user artistic acceptance.

### Measured motion checks

`motion-check` (MCP `motion_check_motion`) samples one clip with the viewer's glTF interpolation and reports three defect families: rotation flips (a sampled turn above 90° per step, near-180° key segments with an undefined direction, quaternion sign flips that only matter for CUBICSPLINE or component-wise importers), planted-foot slip (contacts detected by height near the clip's lowest foot position, or given explicitly), and limb extension (a knee/elbow bend change above 20° in one step while nearly straight, or a chain longer than its rest length). In-place locomotion is recognized: a stance foot moving backward at a constant speed is reported as `treadmill`, not slip, and differing speeds between steps are flagged.

Run it on the job input and on your candidate in one call when the edit touches legs, arms or rotation curves:

```sh
node "$SKILL_DIR/scripts/motion-feedback.mjs" motion-check --workspace "$WORKSPACE" --asset-id "$ASSET" --baseline-slot baseline --file "$CANDIDATE_GLB" --clip "$CLIP"
```

Findings are marked `new`, `existing` or `resolved`. Report `new` warnings and either fix them or explain why they are intended; pre-existing ones are context, not the edit's fault. Foot nodes are guessed from names (`footSelection: "name-hint"`) unless `--feet` names the ankle nodes; a guess is a hint, not anatomical identity. Pass contact windows, extra arm chains or a floor height with `--options PARAMS.json` (`{"contacts":{"LeftFoot":[[0,0.3]]},"chains":[["LeftArm","LeftForeArm","LeftHand"]]}`). The checks measure joint positions only: they cannot prove mesh collision freedom, natural motion or runtime IK behavior, and they never gate completion.

### Completion gate

`completeJob` is the shared completion gate for workers, CLI, MCP and local edits. It enforces the lease, immutable input/model revision, project/source drift, a distinct candidate and retained clip names. `candidate-validation.mjs` checks the complete GLB container, embedded buffer/accessor ranges, readable finite float data, node transforms and animation targets/counts/time ordering. It records these program checks separately as `job.validation`; an agent's optional audit cannot override them. Compressed payloads are not decoded and sparse/compressed animation ordering is not expanded by this lightweight check; its recorded limitations identify the remaining viewer checks. The validator does not interpret free-text preservation requirements or decide artistic quality. Check task-specific protected properties during authoring.

Reuse the existing studio for playback and candidate comparison. A routine GLB edit should not launch a browser or external player, build another renderer, or generate a video solely to validate the edit. Use Blender for necessary native editing/baking/conversion. A fresh import is useful when that export path can lose constraints, shift time or otherwise change the requested result; it is not a universal extra step for direct GLB data edits.

Optional verification is advisory. If its tool is missing, crashes, times out or is denied, record the limitation once, stop that verification path and return the ready candidate. Do not retry or assemble fallback tools for optional checks. An absent, malformed, oversized or stale `audit.json` does not prevent a valid candidate from returning. Failed necessary file checks or an unavailable tool/source required to author the repair still block submission. Do not classify an optional playback failure alone as `needs-input`, and never publish an unfinished candidate merely because a file exists.

```sh
node "$SKILL_DIR/scripts/motion-feedback.mjs" complete --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --candidate "$CANDIDATE_GLB" --summary "$SUMMARY" --audit "$AUDIT_JSON"   # --audit is optional
node "$SKILL_DIR/scripts/motion-feedback.mjs" needs-input --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --error "具体的问题"
node "$SKILL_DIR/scripts/motion-feedback.mjs" fail --workspace "$WORKSPACE" --job "$ID" --lease "$LEASE" --error "具体的原因"
```

Complete the claimed task with the new candidate and a concrete summary of what changed and what was checked. Completion compares current input identities to the task snapshot; stale results must remain historical instead of replacing newer work. Never override that guard, and never label an unchanged copy as an improvement. Returning a candidate does not install it into a production game.

## Compare and decide

The candidate is a new self-contained GLB; the original stays. State which bones, which interval and which preserved data the edit covers. Quantifiable checks carry real measurements. A game that was not run or an action that was not watched does not count as passed.

When the candidate returns, the page restores the submission's input time, camera, speed, loop, root-motion lock and alignment, for single, side-by-side or onion-skin (叠影) comparison. Progress-based comparison rebuilds the shared clock from the input's local seconds, so a changed candidate duration does not make the input jump to another pose. Both versions share the frozen input's scale and offset; raw-scale mode keeps asset coordinates and size. Never scale the candidate on its own to hide a scale change. Default playback uses equal elapsed time and a shorter clip holds its last frame; normalised progress must not mask a timing change. 原地看动作 changes only the display; turn it off to check real root travel.

Technical completion and user approval are separate. Only a decision the user clicks is aesthetic acceptance. Accepting the candidate, continuing to revise, and keeping the original each bind to the reviewed model versions; none of them writes into the game. The user may pick a rejection reason and add a note, or leave both empty. Restoring a historical checkpoint is a separate, explicit operation; it verifies the current version and refuses to overwrite an active task on the same model.

## Legacy records

The v2 flow uses `jobs/<id>/` with `task.md`, `context.json`, `job.json`, `view.png` and the execution output. The task template is `assets/templates/task.md`. Older `feedback.json`, `marks.json` and templates remain readable and exportable, and historical cases keep their original words and decisions. They are compatibility records and cannot replace a v2 claim, execution and candidate return.
