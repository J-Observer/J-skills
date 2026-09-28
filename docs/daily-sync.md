# Daily upstream synchronization

This fork retains the Windows adaptations while following `yan-labs/yan-skills/main`.

- GitHub checks daily at **09:17 Asia/Hong_Kong** (`01:17 UTC`). The workflow can also be run manually. GitHub may delay scheduled jobs and may disable them after 60 days of repository inactivity.
- The Windows task checks daily at **11:17 Asia/Hong_Kong**. A login after that time catches up if the day's check was missed. A persisted date prevents additional network checks that day.
- The source checkout uses `origin = J-Observer/J-skills` and `upstream = yan-labs/yan-skills`.
- GitHub merges and runs the offline update gate before a normal push. Conflicts, failed checks or concurrent pushes leave `main` unchanged and create/update one GitHub issue. Workflow failures also appear in Actions notifications according to the account's notification settings.
- Locally, dirty source files, divergence or edited installed files block the update. A temporary checkout is tested before the source advances. Only this repository's skills and shared `scripts`, `docs`, `platforms` directories are installed. Other skills are untouched.
- Installation preserves untracked runtime files such as `.env`; tracked customizations cause a stop. Dependencies follow the agent-fleet lockfile. Renamed or removed skills are archived with their old mirrors. The nested `agent-fleet/skill/SKILL.md` layout is supported.
- `.agents/skills/.j-skills-managed.json` records file hashes and the deployed commit. Rankup's individual self-update defers to this daily process. The skills lockfile points to this fork.

## Local operation

Prerequisites: Windows, Git, Node.js 24, Python 3.13 with PyYAML 6.0.3, GitHub CLI authenticated for this fork.

```powershell
# Check and apply now, independently of the daily throttle.
python scripts/maintenance/update_local.py

# Register/refresh this user's daily task.
powershell -NoProfile -File scripts/maintenance/register-task.ps1

# Inspect the deployed version and last attempt.
Get-Content "$env:LOCALAPPDATA/J-skills/status.json"
Get-Content "$env:USERPROFILE/.agents/skills/.j-skills-managed.json"

# Pause/resume the local schedule.
Disable-ScheduledTask -TaskName 'J-skills Daily Update'
Enable-ScheduledTask -TaskName 'J-skills Daily Update'
```

Logs, state and backups live in `%LOCALAPPDATA%/J-skills`. No credentials are committed. Initial installation is explicit: `--install-current --bootstrap-ref <saved-baseline-branch>`; subsequent updates use the installation manifest.

## Failure and rollback

An ordinary installation exception reverses directory/link moves and restores the lockfile and installation manifest. If the source was fast-forwarded, it is rolled back only if it still has the exact expected commit and no concurrent edits. Every prior source commit has a `backup/local-*` branch.

Backups retain previous directories, mirrors, lockfile and a move journal. A process termination during installation leaves `pending.json`; subsequent runs stop for recovery instead of guessing. Pause the task, inspect that journal, reverse completed moves, and restore the saved lockfile/manifest. Never delete backup directories without checking that they contain no unique runtime files. Source backup branches do not contain ignored `.env` files; the installation backups do.

The gate covers Skill metadata, Windows launcher arguments, update isolation, shared-data schemas and the rankup/backlink/opencli offline test suites, plus agent-fleet unit tests and installer rollback/drift tests. It does not prove every authenticated browser workflow or third-party service is available. New upstream shell-only tools can still require their documented shell/dependencies.

## Initial integration (2026-09-28)

Upstream removed `game-opportunity` and `skillsmp`, and moved the agent-fleet Skill to `agent-fleet/skill`. The old installed directories are archived, not silently kept as current upstream features. Existing Windows launcher adaptations were retained. The upstream Clarity change needed an argument-array fix; the offline tests were adjusted for Git Bash and the removal of game-opportunity. The GEO write-panel test explicitly skips when its `jq` dependency is absent.
