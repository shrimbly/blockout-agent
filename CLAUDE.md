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
