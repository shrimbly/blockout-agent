---
name: start
description: Start Blockout - open the blockout canvas in the browser and listen for prompts typed there. Run only when the user invokes /blockout-agent:start.
disable-model-invocation: true
argument-hint: "[what to block out]"
allowed-tools: Bash(canvas:*), Bash(command -v canvas), Skill(blockout-agent:camera-canvas)
---

Start Blockout for the user, then load the `camera-canvas` skill and follow it for everything after.

1. Run `canvas up`. It starts the local server (if it is not already running) and opens
   http://127.0.0.1:5317 in the user's browser. If `canvas` is not found, the plugin is not on PATH yet:
   tell the user to run `/reload-plugins` or start a new session, and stop.
2. Run `canvas listen on`, so prompts typed in the canvas come to this session.
3. Run `canvas ls` to read the scene.
4. If `canvas status` shows no tab open (a remote or headless machine), say so and give the URL.

Then reply in one or two lines: the canvas is open and you are listening, and they can describe a scene
and camera move here or in the canvas chat.

If the user wrote something after the command ($ARGUMENTS), treat it as their first scene request and
start building it straight away instead of asking.
