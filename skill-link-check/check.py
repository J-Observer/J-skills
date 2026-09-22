#!/usr/bin/env python3
"""Audit .agents/skills vs .claude/skills consistency."""
from __future__ import annotations

import argparse
import json
import os
import shlex
import sys
from collections import Counter
from dataclasses import asdict, dataclass, field
from pathlib import Path


@dataclass
class Issue:
    kind: str
    name: str
    detail: str
    fix: str


@dataclass
class ScopeResult:
    label: str
    root: Path
    agents: Path
    claude: Path
    mode: str = ""
    issues: list[Issue] = field(default_factory=list)
    n_agents_skills: int = 0
    n_claude_entries: int = 0


def _q(path: Path) -> str:
    return shlex.quote(str(path))


def _children(path: Path) -> dict[str, Path]:
    if not path.is_dir():
        return {}
    return {
        child.name: child
        for child in path.iterdir()
        if not child.name.startswith(".")
    }


def _is_link(path: Path) -> bool:
    return path.is_symlink() or getattr(path, "is_junction", lambda: False)()


def _describe(path: Path) -> str:
    if _is_link(path):
        target = os.readlink(path)
        suffix = " (broken)" if not path.exists() else ""
        kind = "junction" if getattr(path, "is_junction", lambda: False)() else "symlink"
        return f"{kind} -> {target}{suffix}"
    if path.is_dir():
        return "real directory"
    if path.exists():
        return "exists but not a directory"
    return "not present"


def _relative_child_target(name: str) -> str:
    return f"../../.agents/skills/{name}"


def audit_scope(label: str, root: Path) -> ScopeResult | None:
    root = root.expanduser().resolve()
    agents = root / ".agents" / "skills"
    claude = root / ".claude" / "skills"
    agents_present = _is_link(agents) or agents.exists()
    claude_present = _is_link(claude) or claude.exists()
    if not agents_present and not claude_present:
        return None

    result = ScopeResult(label=label, root=root, agents=agents, claude=claude)

    if not agents_present:
        if _is_link(claude) and not claude.exists():
            result.mode = "parent-symlink-broken"
            result.issues.append(Issue(
                kind="broken-symlink",
                name="<.claude/skills>",
                detail=f"{claude} -> {os.readlink(claude)} (target missing)",
                fix=(
                    f"rm {_q(claude)}\n"
                    f"  mkdir -p {_q(agents)}\n"
                    f"  ln -s {_q(agents)} {_q(claude)}"
                ),
            ))
            return result

        result.mode = "no-agents"
        claude_children = _children(claude)
        result.n_claude_entries = len(claude_children)
        for name, child in sorted(claude_children.items()):
            destination = agents / name
            result.issues.append(Issue(
                kind="orphan-in-claude",
                name=name,
                detail=f"{child} has no source under {agents}",
                fix=(
                    f"mkdir -p {_q(agents)}\n"
                    f"  mv {_q(child)} {_q(destination)}\n"
                    f"  ln -s {shlex.quote(_relative_child_target(name))} {_q(child)}"
                ),
            ))
        return result

    agents_children = _children(agents)
    result.n_agents_skills = len(agents_children)

    if not claude_present:
        result.mode = "no-claude"
        for name in sorted(agents_children):
            mirror = claude / name
            result.issues.append(Issue(
                kind="missing-link",
                name=name,
                detail=f"{agents / name} has no counterpart in {claude}",
                fix=(
                    f"mkdir -p {_q(claude)}\n"
                    f"  ln -s {shlex.quote(_relative_child_target(name))} {_q(mirror)}"
                ),
            ))
        return result

    if _is_link(claude):
        try:
            resolved = claude.resolve(strict=True)
        except (FileNotFoundError, OSError):
            resolved = None
        expected = agents.resolve()
        if resolved == expected:
            result.mode = "parent-symlink"
            result.n_claude_entries = result.n_agents_skills
            return result
        kind = "broken-symlink" if resolved is None else "wrong-target"
        result.mode = f"parent-symlink-{kind}"
        detail = f"{claude} -> {os.readlink(claude)}"
        if resolved is None:
            detail += " (target missing)"
        else:
            detail += f" (resolves to {resolved}, expected {expected})"
        result.issues.append(Issue(
            kind=kind,
            name="<.claude/skills>",
            detail=detail,
            fix=f"rm {_q(claude)}\n  ln -s {_q(agents)} {_q(claude)}",
        ))
        return result

    result.mode = "per-child"
    claude_children = _children(claude)
    result.n_claude_entries = len(claude_children)

    for name in sorted(set(agents_children) | set(claude_children)):
        in_agents = name in agents_children
        in_claude = name in claude_children

        if in_agents and not in_claude:
            mirror = claude / name
            result.issues.append(Issue(
                kind="missing-link",
                name=name,
                detail=f"{agents / name} has no symlink in {claude}",
                fix=f"ln -s {shlex.quote(_relative_child_target(name))} {_q(mirror)}",
            ))
            continue

        mirror = claude_children[name]

        if in_claude and not in_agents:
            if _is_link(mirror):
                target = os.readlink(mirror)
                if not mirror.exists():
                    result.issues.append(Issue(
                        kind="broken-symlink",
                        name=name,
                        detail=f"{mirror} -> {target} (target missing, no source in .agents)",
                        fix=f"rm {_q(mirror)}",
                    ))
                else:
                    destination = agents / name
                    result.issues.append(Issue(
                        kind="wrong-target",
                        name=name,
                        detail=f"{mirror} -> {target} (no {destination} exists)",
                        fix=(
                            "# Decide whether to copy the external target into .agents:\n"
                            f"  cp -R {_q(mirror)}/ {_q(destination)}\n"
                            f"  rm {_q(mirror)}\n"
                            f"  ln -s {shlex.quote(_relative_child_target(name))} {_q(mirror)}"
                        ),
                    ))
            else:
                destination = agents / name
                result.issues.append(Issue(
                    kind="orphan-in-claude",
                    name=name,
                    detail=f"{mirror} is a real entry but {destination} does not exist",
                    fix=(
                        f"mv {_q(mirror)} {_q(destination)}\n"
                        f"  ln -s {shlex.quote(_relative_child_target(name))} {_q(mirror)}"
                    ),
                ))
            continue

        source = agents / name
        if _is_link(mirror):
            target = os.readlink(mirror)
            try:
                resolved = mirror.resolve(strict=True)
            except (FileNotFoundError, OSError):
                resolved = None
            expected = source.resolve()
            if resolved is None:
                result.issues.append(Issue(
                    kind="broken-symlink",
                    name=name,
                    detail=f"{mirror} -> {target} (broken)",
                    fix=(
                        f"rm {_q(mirror)}\n"
                        f"  ln -s {shlex.quote(_relative_child_target(name))} {_q(mirror)}"
                    ),
                ))
            elif resolved != expected:
                result.issues.append(Issue(
                    kind="wrong-target",
                    name=name,
                    detail=f"{mirror} -> {target} (resolves to {resolved}, expected {expected})",
                    fix=(
                        f"rm {_q(mirror)}\n"
                        f"  ln -s {shlex.quote(_relative_child_target(name))} {_q(mirror)}"
                    ),
                ))
        else:
            result.issues.append(Issue(
                kind="not-symlink",
                name=name,
                detail=f"{mirror} is a real entry, duplicating {source}",
                fix=(
                    "# Inspect for divergence first, then collapse to a symlink:\n"
                    f"  diff -rq {_q(mirror)} {_q(source)}\n"
                    f"  rm -rf {_q(mirror)}\n"
                    f"  ln -s {shlex.quote(_relative_child_target(name))} {_q(mirror)}"
                ),
            ))

    return result


def _issue_summary(issues: list[Issue]) -> str:
    counts = Counter(issue.kind for issue in issues)
    preferred = ["orphan-in-claude", "missing-link", "not-symlink", "broken-symlink", "wrong-target"]
    ordered = [(kind, counts.pop(kind)) for kind in preferred if counts[kind]]
    ordered.extend(sorted(counts.items()))
    return ", ".join(f"{count} {kind}" for kind, count in ordered)


def print_report(results: list[ScopeResult]) -> int:
    print("Skill link check")
    print("=" * 16)
    if not results:
        print("No .agents/skills or .claude/skills found in the selected scope(s).")
        return 0

    total = 0
    for result in results:
        print(f"\n[{result.label}] {result.root}")
        print(f"  .agents/skills: {_describe(result.agents)} ({result.agents})")
        print(f"  .claude/skills: {_describe(result.claude)} ({result.claude})")
        print(f"  Mode: {result.mode}")
        if result.mode == "parent-symlink":
            print(f"  OK: {result.n_agents_skills} skills consistent (parent-symlink layout).")
            continue
        if not result.issues:
            print("  OK: No issues.")
            continue
        print(f"  WARN: {len(result.issues)} issue(s): {_issue_summary(result.issues)}")
        for issue in sorted(result.issues, key=lambda item: (item.kind != "orphan-in-claude", item.kind, item.name)):
            total += 1
            print(f"\n    [{issue.kind}] {issue.name}")
            print(f"      {issue.detail}")
            print("      Suggested fix (review before running):")
            for line in issue.fix.splitlines():
                print(f"        {line}")

    print(f"\nTotal issues: {total}" if total else "\nAll selected scopes look healthy.")
    return total


def json_report(results: list[ScopeResult]) -> int:
    payload = {
        "ok": not any(result.issues for result in results),
        "total_issues": sum(len(result.issues) for result in results),
        "scopes": [],
    }
    for result in results:
        item = asdict(result)
        item["root"] = str(result.root)
        item["agents"] = str(result.agents)
        item["claude"] = str(result.claude)
        item["issue_counts"] = dict(Counter(issue.kind for issue in result.issues))
        payload["scopes"].append(item)
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return payload["total_issues"]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", type=Path, default=Path.cwd(), help="project root to audit")
    scope = parser.add_mutually_exclusive_group()
    scope.add_argument("--project-only", action="store_true", help="skip the global home scope")
    scope.add_argument("--global-only", action="store_true", help="skip the project scope")
    parser.add_argument("--json", action="store_true", help="emit stable JSON evidence")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    project_root = args.project_root.expanduser().resolve()
    home = Path.home().resolve()
    results: list[ScopeResult] = []

    if not args.global_only:
        project = audit_scope("Project", project_root)
        if project is not None:
            results.append(project)

    if not args.project_only and (args.global_only or project_root != home):
        global_result = audit_scope("Global", home)
        if global_result is not None:
            results.append(global_result)

    total = json_report(results) if args.json else print_report(results)
    return 1 if total else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
