# Internal Issue Tracking — GitHub Issues Skill

## Summary

Instead of building a bespoke issue tracker in SQLite, use GitHub Issues as the backend.
The agent gets a **skill** (tool) that lets it create, search, label, and close issues
in a configured GitHub repo via the `gh` CLI or the GitHub REST API. No new DB tables,
no new API routes in Boilerhouse — just a skill definition the agent can invoke.

---

## Why GitHub Issues, not a custom DB

- Already has labels, milestones, assignees, search, cross-references, notifications.
- Issues are visible in the GitHub UI — the team can triage without going through the bot.
- Survives sessions trivially (it's a remote service).
- The `gh` CLI is already available in Claude Code containers.
- Avoids maintaining a parallel issue store that drifts from reality.

---

## Architecture

The skill is an MCP tool (or Claude Code slash-command skill) exposed to the agent at
session startup. The agent calls it like any other tool — no special driver integration
needed.

```
User: "that auth bug is back, can you file an issue?"
Agent: [calls github_issues.create tool]
  → POST /repos/{owner}/{repo}/issues { title, body, labels }
Agent: "Filed zdavison/boilerhouse#52 — tagged as bug, priority:high"
```

The skill talks to GitHub via either:
- **`gh` CLI** (simplest — already authed in Claude Code containers via `gh auth`)
- **GitHub REST API** (more portable — works from any container with a PAT)

Recommend `gh` CLI as primary since it handles auth, pagination, and formatting. Fall
back to REST API + PAT for non-Claude-Code containers.

---

## Skill Definition

### Tool: `github_issues`

**Actions:**

#### `create`
- **Params:** `title` (required), `body` (optional), `labels` (optional string[]), `assignees` (optional string[]), `milestone` (optional string)
- **Impl:** `gh issue create --repo {repo} --title {title} --body {body} --label {labels} --assignee {assignees}`
- **Returns:** Issue URL and number

#### `list`
- **Params:** `state` (open/closed/all, default open), `labels` (optional string[]), `search` (optional free-text query), `limit` (default 20)
- **Impl:** `gh issue list --repo {repo} --state {state} --label {labels} --search {search} --limit {limit} --json number,title,state,labels,url`
- **Returns:** JSON array of issues

#### `view`
- **Params:** `number` (required)
- **Impl:** `gh issue view {number} --repo {repo} --json number,title,body,state,labels,comments,url`
- **Returns:** Full issue details including comments

#### `close`
- **Params:** `number` (required), `comment` (optional — closing reason)
- **Impl:** `gh issue close {number} --repo {repo} --comment {comment}`
- **Returns:** Confirmation

#### `comment`
- **Params:** `number` (required), `body` (required)
- **Impl:** `gh issue comment {number} --repo {repo} --body {body}`
- **Returns:** Comment URL

#### `edit`
- **Params:** `number` (required), `title` (optional), `body` (optional), `add_labels` (optional string[]), `remove_labels` (optional string[])
- **Impl:** `gh issue edit {number} --repo {repo} --title {title} --body {body} --add-label {labels} --remove-label {labels}`
- **Returns:** Updated issue URL

---

## Configuration

The skill needs to know which repo to target. Two options:

### Option A: Environment variable (simplest)

```
GITHUB_ISSUES_REPO=zdavison/boilerhouse
```

Set in the workload's `driverOptions` or `entrypoint.env`. The skill reads it at
invocation time. One repo per workload — fine for most setups.

### Option B: Per-tenant repo mapping

For multi-tenant deployments where each tenant has their own repo:
- Store `github_repo` in `tenant_secrets` via `SecretStore`
- The skill resolves `${tenant-secret:github_repo}` at call time

Start with Option A. Add B when needed.

### Authentication

- **Claude Code containers:** `gh` CLI is pre-authed via the MITM auth proxy that
  injects GitHub credentials. No additional config needed.
- **Other containers:** Set `GITHUB_TOKEN` (PAT with `repo` scope) in the workload env.
  The skill falls back to `curl` / `fetch` with `Authorization: Bearer` header if `gh`
  is not available.

---

## Implementation Options

### Option 1: Claude Code skill file (fastest)

A markdown skill file at `docs/superpowers/github-issues.md` (or wherever the agent's
skill pack is loaded from) that describes the tool and provides the `gh` commands as
executable steps. Claude Code already knows how to execute shell commands — the skill
just needs to frame them correctly.

**Pros:** Zero code, ships today, works in any Claude Code session.
**Cons:** Not a structured MCP tool — relies on Claude Code's bash tool. Less portable.

### Option 2: MCP tool server (more robust)

A small MCP tool server (`packages/skill-github-issues/`) that exposes the
`github_issues` tool over the MCP protocol. The agent connects to it like any other
MCP server.

```
packages/skill-github-issues/
  src/
    index.ts        — MCP server entry point
    github.ts       — gh CLI wrapper or REST API client
    tools.ts        — tool definitions (create, list, view, close, comment, edit)
  package.json
```

**Pros:** Structured tool schema, input validation, works across all drivers (not just
Claude Code), composable with the skill pack.
**Cons:** More code, needs MCP server infrastructure.

### Recommendation: Start with Option 1, migrate to Option 2

Option 1 is zero-code and gets the feature working immediately. When the skill pack
infrastructure is in place, wrap it as an MCP tool (Option 2) for better structure and
cross-driver support.

---

## File Changes

### Option 1 (skill file only)

| File | Action |
|------|--------|
| `docs/superpowers/skills/github-issues.md` | Create — skill definition with `gh` commands |

### Option 2 (MCP tool server, follow-up)

| File | Action |
|------|--------|
| `packages/skill-github-issues/package.json` | Create — package definition |
| `packages/skill-github-issues/src/index.ts` | Create — MCP server entry |
| `packages/skill-github-issues/src/github.ts` | Create — `gh` CLI wrapper |
| `packages/skill-github-issues/src/tools.ts` | Create — tool definitions |
| `packages/skill-github-issues/src/github.test.ts` | Create — unit tests |

---

## Skill File Sketch (Option 1)

```markdown
# GitHub Issues

You can create, search, and manage GitHub issues using the `gh` CLI.

## Configuration

The target repository is set via the `GITHUB_ISSUES_REPO` environment variable.

## Creating an issue

\`\`\`bash
gh issue create --repo "$GITHUB_ISSUES_REPO" \
  --title "Issue title" \
  --body "Detailed description" \
  --label "bug"
\`\`\`

## Listing issues

\`\`\`bash
gh issue list --repo "$GITHUB_ISSUES_REPO" \
  --state open \
  --json number,title,state,labels,url
\`\`\`

## Viewing an issue

\`\`\`bash
gh issue view 42 --repo "$GITHUB_ISSUES_REPO" \
  --json number,title,body,state,labels,comments,url
\`\`\`

## Closing an issue

\`\`\`bash
gh issue close 42 --repo "$GITHUB_ISSUES_REPO" \
  --comment "Resolved in commit abc123"
\`\`\`

## Adding a comment

\`\`\`bash
gh issue comment 42 --repo "$GITHUB_ISSUES_REPO" \
  --body "Update: this is now reproducible on staging"
\`\`\`
```

---

## Test Strategy

### Option 1 (skill file)

No automated tests — the skill is a documentation file. Manual verification:
1. Set `GITHUB_ISSUES_REPO` in a test workload.
2. Ask the agent to "file a bug about the login page being slow".
3. Verify the issue appears in GitHub with correct title, body, and labels.
4. Ask the agent to "list open bugs" — verify it returns real issues.
5. Ask the agent to close the test issue.

### Option 2 (MCP server, follow-up)

Unit tests for `github.ts`:
- Mock `Bun.spawn` / `child_process.exec` for `gh` CLI calls.
- Assert correct `gh` command construction for each action.
- Assert JSON output parsing.
- Assert error handling (gh not installed, auth failure, rate limit).

Integration test:
- Use a dedicated test repo (e.g. `zdavison/boilerhouse-test-issues`).
- Create → list → view → comment → close → verify state transitions.
- Clean up test issues after run.

---

## Open Questions

- **Issue templates:** Should the skill encourage structured issue bodies (repro steps,
  expected vs actual) or let the agent decide the format? Leaning toward agent discretion
  with gentle guidance in the skill description.
- **Cross-repo:** For monorepo setups where issues should go to different repos depending
  on the component, the skill could accept an optional `repo` parameter override. Start
  without this.
- **Rate limiting:** GitHub API has rate limits (5000 req/hr for authenticated users).
  Not a concern for typical usage but worth noting for high-volume deployments.
- **Issue deduplication:** The agent might create duplicate issues for the same bug.
  The skill's `list` + `search` actions let the agent check first, but this depends on
  the agent being prompted to do so. Consider adding "search before creating" guidance
  in the skill description.
