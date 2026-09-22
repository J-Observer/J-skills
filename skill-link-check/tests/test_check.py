from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
SCRIPT = SKILL_DIR / "check.py"
SPEC = importlib.util.spec_from_file_location("skill_link_check", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


def directory_link(link: Path, target) -> None:
    target = Path(target)
    if os.name == "nt":
        resolved = target if target.is_absolute() else link.parent / target
        subprocess.run(["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(resolved.resolve())], check=True, capture_output=True)
    else:
        link.symlink_to(target, target_is_directory=True)


class SkillLinkCheckTests(unittest.TestCase):
    def test_parent_symlink_layout_is_clean(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agents = root / ".agents" / "skills"
            agents.mkdir(parents=True)
            (agents / "demo").mkdir()
            (root / ".claude").mkdir()
            directory_link(root / ".claude" / "skills", agents)

            result = MODULE.audit_scope("Project", root)

            self.assertIsNotNone(result)
            self.assertEqual("parent-symlink", result.mode)
            self.assertEqual([], result.issues)

    def test_per_child_layout_reports_all_core_issue_types(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            agents = root / ".agents" / "skills"
            claude = root / ".claude" / "skills"
            agents.mkdir(parents=True)
            claude.mkdir(parents=True)
            for name in ("missing", "duplicate", "broken", "wrong"):
                (agents / name).mkdir()
            (claude / "duplicate").mkdir()
            (claude / "orphan").mkdir()
            directory_link(claude / "broken", "../../.agents/skills/nope")
            outside = root / "outside"
            outside.mkdir()
            directory_link(claude / "wrong", outside)

            result = MODULE.audit_scope("Project", root)
            kinds = {issue.kind for issue in result.issues}

            self.assertEqual(
                {"missing-link", "not-symlink", "orphan-in-claude", "broken-symlink", "wrong-target"},
                kinds,
            )

    def test_broken_parent_symlink_is_not_silently_clean(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".claude").mkdir()
            directory_link(root / ".claude" / "skills", "../missing-skills")

            result = MODULE.audit_scope("Project", root)

            self.assertEqual("parent-symlink-broken", result.mode)
            self.assertEqual(["broken-symlink"], [issue.kind for issue in result.issues])

    def test_json_mode_is_machine_readable_and_nonzero_on_findings(self) -> None:
        with tempfile.TemporaryDirectory(prefix="skill link check ") as tmp:
            root = Path(tmp)
            (root / ".agents" / "skills" / "demo").mkdir(parents=True)

            completed = subprocess.run(
                [sys.executable, str(SCRIPT), "--project-root", str(root), "--project-only", "--json"],
                check=False,
                capture_output=True,
                text=True,
            )
            payload = json.loads(completed.stdout)

            self.assertEqual(1, completed.returncode)
            self.assertFalse(payload["ok"])
            self.assertEqual(1, payload["total_issues"])
            self.assertIn("'", payload["scopes"][0]["issues"][0]["fix"])


if __name__ == "__main__":
    unittest.main()
