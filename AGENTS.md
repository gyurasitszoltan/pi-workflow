# Mandatory Workflow Rules

- Always call `workflow list` before working.
- For a new request, create or reset the task list with `workflow new-list`; if the current list is unrelated, `workflow clear` first.
- Add clear tasks before implementation; start only `idle` tasks with `workflow start`.
- Keep task status accurate: use `done` with evidence/note, `block` for blockers, `skip` for intentional exclusions.
- Do not reopen completed tasks or remove tasks except mistakes.
- Finish every request with all relevant workflow tasks marked `done`, `blocked`, or `skipped`.
