---
name: check-postmortem
description: Review past bug-fix postmortem reports stored under `.agents/postmortem` and surface likely relevant historical fixes. Use when the coding agent is debugging or implementing a bug fix and wants examples of similar root causes, fixes, touched files, or verification patterns before proceeding.
---

# Check Postmortem

## Overview

Use this skill to inspect the repository's prior bug-fix reports before guessing at a new fix.

In this project, every completed bug fix must eventually create exactly one markdown file under `.agents/postmortem/`. Those files use JSON frontmatter and include at least `title` and `summary`, followed by concise sections such as `Root Cause`, `Fix`, `Files Changed`, `Verification`, and `Follow-up`.

## Workflow

1. Run the index script from the repository root:

```bash
python .agents/skills/check-postmortem/scripts/list_postmortems.py
```

2. Read the JSON output. Each item contains:
   - `file_path`
   - `title`
   - `summary`

3. Compare the current bug with the list using concrete signals:
   - similar symptoms or UI/runtime behavior
   - shared components, files, or subsystem names
   - matching failure mode, root-cause shape, or verification pattern

4. If one or more entries look relevant, open those postmortem files and read the full report before reusing any approach.

## Usage Notes

- Treat the script output as a triage index, not the final answer.
- Prefer opening the full report whenever a title or summary looks even partially related.
- Reuse prior fixes carefully. Borrow the debugging path and validation ideas, but confirm the current bug still matches the same root cause.
- If no entry looks relevant, continue with normal debugging instead of forcing a historical match.
