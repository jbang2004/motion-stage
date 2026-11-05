# Agent execution and evidence

The studio is a feedback client. Reading a selection or saving a note does not start a model turn. A submitted task is durable, with frozen baseline and candidate identities. Its state is authoritative; the UI never invents progress.

## Choose the connection

- **Current chat:** read queued tasks through the CLI or stdio MCP. Claim one, inspect its task/context packet and actual source, build an isolated candidate, then complete with the lease. The current chat's installed tools remain available. This route does not require another model API key or a background worker.
- **Local Codex worker:** the user explicitly connects the locally installed, logged-in Codex CLI. It starts separate non-interactive Codex turns using the user's configured model, with a per-job writable output directory. It consumes that account's normal usage. The worker checks final output and current versions before publishing a candidate. Disconnect/cancel stops further execution. No new key is requested in chat.
- **Other assistants:** use the same CLI/MCP task contract. A Claude worker is not bundled. Do not describe a queued task as having reached a running agent without a real consumer.
- **Local parameter edit:** an explicitly named bone, clip, time scope and swing factor can be applied by the deterministic animation-data tool. This is a parameter transformation, not an AI artistic judgment or a universal naturalness fix.

## Explain actual progress

Once claimed, report the stage as it changes with `progress --workspace PATH --job ID --lease TOKEN --phase PHASE --message TEXT`, or `motion_report_progress`. The four stages are `reading`, `editing`, `checking`, `exporting`. A stage may return to editing when a check exposes another issue. A stage label does not prove every preceding check passed.

Messages should tell the user what is happening to their model in one short sentence. Report real operations and results; do not invent percentages, remaining time or artistic acceptance. CLI command start/end events update recent activity without guessing a stage. The worker surfaces only user-visible messages, never reasoning or raw command/output bodies. Its job-local `progress.json` accepts `{ "phase": "checking", "message": "正在核对未修改的腿部与根运动。" }`; overwrite atomically at meaningful transitions.

The studio displays elapsed time and time since last activity. Silence means no new progress was reported; it does not imply the model is stuck or that another stage has completed. Cancellation invalidates the lease, so a late process cannot overwrite status or deliver a candidate.

If clarification is needed, fail with `needs-input` and a specific question. The user can answer directly in the task panel. `reply --job ID --message TEXT` / `motion_reply_job` records the answer in task/context and queues the same version-bound task again. Reclaim returns a new lease; the worker clears old stage files for the new attempt. If assets changed, the reply is refused as stale; start a fresh task on the current source.

## Inspect before modifying

Read `task.md` and `context.json` in the job folder. Verify asset SHA, clip, selection, time range, playback mode and model-to-view transforms. Seconds are the primary time reference. `round(time * reviewFPS)` is a review index, not a source Blender frame. FBX intake records source FPS and first frame; retiming can require a nonlinear mapping.

Use asset inspection to read the relevant skeleton hierarchy, rest transforms, skin influences and animation channels. A screenshot cannot establish bone identity, mesh topology, contact anchors or the cause of a deformation. Selecting a surface provides a mesh and influence hint; the user or agent must confirm the intended semantic target.

Diagnose the responsible layer:

| Observation | Inspect | Likely operation |
|---|---|---|
| Excessive limb swing | Quaternion/Euler channels and scope | Scoped curve edit |
| Wrist should reach a point | Shoulder/elbow chain, reach and grip | IK/constraint solve and bake |
| Shoulder collapses on bending | Weights, joint shape, corrective shapes | Skin or geometry repair |
| Motion twists after transfer | Rest pose, axes, scale, mapping | Explicit retarget and bake |
| Feet slide | Contact phases, root travel and controller speed | Timing/root/IK or runtime repair |
| Sleeve intersects torso | Garment shape, weights, motion and cloth ownership | Repair the responsible layer and rebake affected caches |

Only GLB/FBX may lack the original controls, constraints or garment solver. State that missing source rather than recreating an unrelated rig. The viewer does not reproduce engine shaders, runtime cloth, DQ corrections, controller movement, gameplay blending or terrain IK.

## Build and return

Preserve the immutable input. Author an isolated candidate and reproducible script or edit recipe. Constrain changed bones, channels and time interval. Changing an upper-arm transform moves its descendants in world space; distinguish unchanged local curves from unchanged world positions. Do not compensate for a skinning defect by changing an approved motion without evidence.

Verify the requested change and relevant preserved data with the smallest useful checks. For a curve edit, inspect the captured pose, relevant extrema and scope/loop boundaries, using the same seconds and transforms as the task. Increase sampling only when the repair's risk requires it. Do not routinely sweep thousands of poses. Keep the short audit honest about what was sampled; it is not a proof of continuous collision freedom or user artistic acceptance.

`completeJob` is the shared completion gate for workers, CLI, MCP and local edits. It enforces the lease, immutable input/model revision, project/source drift, a distinct candidate and retained clip names. `candidate-validation.mjs` checks the complete GLB container, embedded buffer/accessor ranges, readable finite float data, node transforms and animation targets/counts/time ordering. It records these program checks separately as `job.validation`; an agent's optional audit cannot override them. Compressed payloads are not decoded and sparse/ compressed animation ordering is not expanded by this lightweight check; its recorded limitations identify the remaining viewer checks. The validator does not interpret free-text preservation requirements or decide artistic quality. Check task-specific protected properties during authoring.

Reuse the existing studio for playback and candidate comparison. A routine GLB edit should not launch a browser or external player, build another renderer, or generate a video solely to validate the edit. Use Blender for necessary native editing/baking/conversion. A fresh import is useful when that export path can lose constraints, shift time or otherwise change the requested result; it is not a universal extra step for direct GLB data edits.

Optional verification is advisory. If its tool is missing, crashes, times out or is denied, record the limitation once, stop that verification path and return the ready candidate. Do not retry or assemble fallback tools for optional checks. An absent, malformed, oversized or stale `audit.json` does not prevent a valid candidate from returning. Failed necessary file checks or an unavailable tool/source required to author the repair still block submission. Do not classify an optional playback failure alone as `needs-input`, and never publish an unfinished candidate merely because a file exists.

Complete the claimed task with the new candidate. Completion compares current input identities to the task snapshot; stale results must remain historical instead of replacing newer work. Returning a candidate does not install it into a production game. The user reviews at the original time and camera, then chooses to retain, revise or accept. Keep each decision attached to the exact compared files.

For a composite character, first resolve the selected clip through `job.source.assembly.clips[clip]` and read the frozen dependency SHA. An embedded clip, exploration GLB and sampled director pack may have different authoring owners. Fix the actual owner when a production-source change is requested; do not edit a similarly named embedded clip and claim the external override changed. A returned composite GLB is a review candidate; native game integration still needs the corresponding source change and runtime check.
