import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_local import assert_unchanged, digest, layout, deploy, write_json


class UpdateTests(unittest.TestCase):
    def test_nested_skill_and_shared_resources(self):
        skills, units, files = layout({'agent-fleet/skill/SKILL.md': b'x',
                                      'rankup/SKILL.md': b'y', 'platforms/a.md': b'z',
                                      '.github/workflows/test.yml': b'w'})
        self.assertEqual(skills['agent-fleet'], 'agent-fleet/skill/SKILL.md')
        self.assertIn('platforms/a.md', files)
        self.assertNotIn('.github/workflows/test.yml', files)

    def test_modified_or_missing_installation_blocks_update(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / 'a').write_bytes(b'original\r\n')
            hashes = {'a': digest(b'original\n')}
            assert_unchanged(root, hashes)
            (root / 'a').write_bytes(b'local customization')
            with self.assertRaisesRegex(RuntimeError, 'local changes'):
                assert_unchanged(root, hashes)
            (root / 'a').unlink()
            with self.assertRaises(RuntimeError):
                assert_unchanged(root, hashes)

    def exercise_deployment(self, fail):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            installed = root / '.agents/skills'
            installed.mkdir(parents=True)
            old = {'demo/SKILL.md': b'old', 'retired/SKILL.md': b'retired'}
            for p, value in old.items():
                (installed / p).parent.mkdir(exist_ok=True)
                (installed / p).write_bytes(value)
            (installed / 'demo/.env').write_bytes(b'private-runtime-fixture')
            lock = installed.parent / '.skill-lock.json'
            lock.write_text(json.dumps({'skills': {'demo': {}, 'retired': {}, 'unrelated': {'source': 'other'}}}))
            original_lock = lock.read_bytes()
            base = {'skills': {'demo': 'demo/SKILL.md', 'retired': 'retired/SKILL.md'},
                    'units': ['demo', 'retired'], 'hashes': {p: digest(b) for p, b in old.items()}}
            new = {'demo/SKILL.md': b'new', 'scripts/a': b'a', 'docs/a': b'a', 'platforms/a': b'a'}
            def writing(path, data):
                if fail and path.name == '.j-skills-managed.json':
                    raise OSError('injected deployment failure')
                write_json(path, data)
            with patch('update_local.tree', return_value=new), patch('update_local.git', return_value='treehash'), \
                 patch('update_local.mirror_dirs', return_value=[]), patch('update_local.write_json', side_effect=writing):
                if fail:
                    with self.assertRaisesRegex(OSError, 'injected'):
                        deploy(root, 'commit', base, installed, root / 'state')
                    self.assertEqual((installed / 'demo/SKILL.md').read_bytes(), b'old')
                    self.assertTrue((installed / 'retired/SKILL.md').exists())
                    self.assertEqual(lock.read_bytes(), original_lock)
                else:
                    result = deploy(root, 'commit', base, installed, root / 'state')
                    self.assertEqual((installed / 'demo/SKILL.md').read_bytes(), b'new')
                    self.assertFalse((installed / 'retired').exists())
                    self.assertTrue((Path(result['backup']) / 'units/retired/SKILL.md').exists())
                    self.assertEqual(json.loads(lock.read_text())['skills']['unrelated']['source'], 'other')
            self.assertEqual((installed / 'demo/.env').read_bytes(), b'private-runtime-fixture')
            self.assertFalse((root / 'state/pending.json').exists())

    def test_success_preserves_runtime_and_archives_retired_skill(self):
        self.exercise_deployment(False)

    def test_failed_deployment_restores_files_and_lock(self):
        self.exercise_deployment(True)


if __name__ == '__main__':
    unittest.main()
