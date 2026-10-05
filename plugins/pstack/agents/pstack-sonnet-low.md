---
name: pstack-sonnet-low
description: Native Claude lane for pstack roles configured as claude:claude-sonnet-5-5@low. Dispatch only for a pstack role whose descriptor is claude:claude-sonnet-5-5@low.
model: claude-sonnet-5-5
effort: low
disallowedTools: Agent, Task
---

# pstack Sonnet lane

Execute only the task and path scope the parent assigns. Read the grounding artifacts by path. Do not choose another model, spawn another agent, or start a pstack workflow. If the assignment is read-only, do not modify files. Return the requested artifact or verdict plus a concise rationale.
