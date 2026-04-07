---
name: release
description: Publish a new version of @danielwyq/netchat to npm and create a corresponding GitHub Release with AI-generated release notes. Use this skill when the user asks to release, publish, or ship a new version.
---

This skill handles the full release workflow for `@danielwyq/netchat`: versioning, npm publishing, and GitHub Release creation.

## Rules

- Do not run npm authentication or publish commands on the user's behalf if they may require browser login, passkey, OTP, or token entry. Give the exact commands to the user and let them run those commands locally.
- Treat unrelated local changes as out of scope. If the working tree must be clean for release, stash only the unrelated paths and restore them after release.
- Do not assume the previous release is the previous tag. If the user provides a release baseline commit, use that commit.
- When using PowerShell with `gh release create` or `gh release edit`, do not put Markdown notes with backticks inside a double-quoted inline string. Use a here-string or a variable.

## Steps

### 1. Confirm release inputs

Ask the user for:

- version bump type: `patch`, `minor`, or `major`
- release baseline: previous tag or previous released commit hash

Use the user-provided baseline if they have one.

### 2. Inspect git state

Run:

```bash
git status --short --branch
git branch --show-current
```

If the working tree is not clean:

- identify which paths are release-related and which are unrelated
- ask whether unrelated changes should be stashed or left for later
- do not mix unrelated changes into the release

If a dedicated release branch is appropriate, create one named after the task. Do not use default branch names such as `main`, `master`, or `dev` for release work.

### 3. Validate the package before versioning

Before `npm version`, make sure the package can actually build.

Run:

```bash
npm run build:package
```

If this fails:

- stop the release flow
- fix the build issue first
- commit the fix
- rerun the build

Do not create the release version commit or tag until the package build is green.

### 4. Bump version

Once the build is clean and the release-only working tree is clean, run:

```bash
npm version <patch|minor|major>
```

This updates the root `package.json`, creates the version commit, and creates the git tag.

If release-blocking fixes are discovered after this step:

- commit the fixes
- move the new tag to the latest release commit before publishing

### 5. Ask the user to run npm commands locally

Do not run npm login, browser auth, passkey auth, OTP flows, or token setup for the user.

Instead, provide the user with these commands to run locally from the repo root:

```bash
npm whoami
npm view @danielwyq/netchat version
npm owner ls @danielwyq/netchat
npm publish
```

If they want to use a token, tell them to validate it themselves first:

```bash
npm config set //registry.npmjs.org/:_authToken=YOUR_TOKEN
npm whoami
```

Only continue after the user confirms the publish succeeded.

Common npm failure buckets:

- build failure: fix code or dependency issues first
- `ENEEDAUTH` or `E401`: user must log in again
- browser/passkey prompt: user must complete it locally
- `E404` on publish: verify package existence, scope ownership, collaborator access, and token capability

After publish, recommend cleanup:

```bash
npm config delete //registry.npmjs.org/:_authToken
```

### 6. Push release refs

Push the release branch and tag explicitly:

```bash
git push origin <release-branch>
git push origin <tag>
```

If the release should land on the default branch, merge it and push that branch too.

### 7. Build release notes from the correct range

Check first if there was a last release tag, if not, ask user for the baseline commit hash or tag to compare against.

Determine the range from the user-confirmed baseline to the new tag:

```bash
git log <baseline>..HEAD --oneline
```

Before drafting release notes, show the user the exact commit list being used.

Generate user-facing notes from release-relevant commits only. Group them into:

- **Features**
- **Bug Fixes**
- **Internal Changes**

Usually skip or compress:

- version-only commits
- lockfile-only commits
- trivial formatting or WIP commits
- repeated revert noise

### 8. Confirm release title and notes

Before creating the GitHub Release, present:

- tag
- title
- notes

Ask for approval before running `gh release create`.

### 9. Create GitHub Release safely in PowerShell

Retrieve the tag:

```bash
git describe --tags --abbrev=0
```

In PowerShell, prefer:

```powershell
$notes = @'
## Bug Fixes
- Example note
'@

gh release create <tag> --title "<title>" --notes $notes
```

If the release already exists or the body needs correction:

```powershell
$notes = @'
<full notes>
'@

gh release edit <tag> --notes $notes
```

If `gh` is unavailable or unauthenticated, output the final title and notes for the user to publish manually.

### 10. Verify and clean up

After GitHub Release creation:

- verify the release body with `gh release view <tag>`
- restore any stashed unrelated changes
- delete the temporary release branch if it has already been merged

If you made code changes during the release process, commit them before ending the conversation.
