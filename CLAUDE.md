@AGENTS.md

## Claude Code specifics

- The `camera-canvas` skill is in `.claude/skills/camera-canvas/`; load it for any canvas work.
- `.claude/settings.json` allows `node bin/canvas.mjs` commands without prompts and installs two hooks:
  - **Stop** → `canvas hook stop`: if the user typed a prompt in the canvas, it blocks the stop and
    gives you that prompt, so you keep working in this same thread. With `canvas listen on` and a tab
    open, it also waits (up to ~55 min) for the next canvas prompt before letting the session idle.
    The user can press Esc in the terminal to interrupt the wait.
  - **UserPromptSubmit** → `canvas hook prompt`: adds any canvas prompts queued while you were busy
    to the context of the user's next terminal message.
  Both are no-ops when the canvas server is not running.
- When the user says "listen", "watch the canvas" or "I'll prompt from the canvas", run
  `node bin/canvas.mjs listen on`, reply with one line saying you're listening, and end your turn.
  When they say stop, run `node bin/canvas.mjs listen off`.
- If hooks are disabled, use `node bin/canvas.mjs wait --timeout 600` as a background command and
  handle each prompt when it completes, then start another wait.
- You can read the PNGs from `canvas snapshot` / `canvas storyboard` directly; do so to check your work.
- Big builds with several separate areas: you are the orchestrator. Spawn `canvas-builder` helpers
  (`.claude/agents/canvas-builder.md`, generated from `skills/camera-canvas/references/builder.md`) in
  one message so they run in parallel, following `skills/camera-canvas/references/orchestration.md`.
  Helpers never listen, reply or touch the camera; you keep the canvas chat, camera and final review.
- Blockout also ships as a Claude Code plugin from this same folder: `.claude-plugin/` (manifest and
  marketplace), `hooks/hooks.json` (the same two hooks), `bin/canvas` (the `canvas` command on PATH) and the
  skill in `skills/`. Keep `hooks/hooks.json` in step with `.claude/settings.json` (npm test checks it). Leave
  `version` out of `.claude-plugin/plugin.json` (npm test checks it): without one, every commit on main is
  an update for installed copies, while a fixed version would hold them on their cached copy.
- Listen mode is owned by one session (`CLAUDE_CODE_SESSION_ID` at `canvas listen on`); the hooks do nothing
  in other sessions. Two copies of a hook in one session (plugin + checkout) take a lock, so only one runs.

