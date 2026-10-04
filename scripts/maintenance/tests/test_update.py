import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from update_local import assert_unchanged, digest, layout, deploy, write_json, ensure_cloud_schedule


class UpdateTests(unittest.TestCase):
    def test_cloud_inactivity_recovers_but_manual_pause_is_preserved(self):
        with patch('update_local.command', side_effect=['disabled_inactivity', '', '']) as calls:
            self.assertEqual(ensure_cloud_schedule(Path.cwd()), 'reenabled-after-inactivity')
            self.assertEqual(calls.call_count, 3)
            self.assertIn('enable', calls.call_args_list[1].args[0])
            self.assertIn('run', calls.call_args_list[2].args[0])
        with patch('update_local.command', return_value='disabled_manually') as calls:
            with self.assertRaisesRegex(RuntimeError, 'intentional pause'):
                ensure_cloud_schedule(Path.cwd())
            self.assertEqual(calls.call_count, 1)

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

    def test_local_registry_survives_repeated_deployments_and_divergence_blocks(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            installed = root / '.agents/skills'
            rel = 'backlink/data/submission-targets.json'
            registry = installed / rel
            registry.parent.mkdir(parents=True)
            registry.write_bytes(b'{"local": 1}')
            (installed / 'backlink/SKILL.md').write_bytes(b'old')
            lock = installed.parent / '.skill-lock.json'
            lock.write_text(json.dumps({'skills': {'backlink': {}}}))
            base = {'skills': {'backlink': 'backlink/SKILL.md'}, 'units': ['backlink'],
                    'hashes': {rel: digest(b'{}'), 'backlink/SKILL.md': digest(b'old')}}
            candidate = {'backlink/SKILL.md': b'new', rel: b'{}',
                         'scripts/a': b'a', 'docs/a': b'a', 'platforms/a': b'a'}
            with patch('update_local.tree', return_value=candidate), patch('update_local.git', return_value='treehash'), \
                 patch('update_local.mirror_dirs', return_value=[]):
                first = deploy(root, 'first', base, installed, root / 'state')
                self.assertEqual(registry.read_bytes(), b'{"local": 1}')
                self.assertEqual(first['sourceHashes'][rel], digest(b'{}'))
                self.assertEqual(first['hashes'][rel], digest(registry.read_bytes()))
                self.assertEqual((Path(first['backup']) / 'units' / rel).read_bytes(), b'{"local": 1}')
                registry.write_bytes(b'{"local": 2}')
                second = deploy(root, 'second', first, installed, root / 'state')
                self.assertEqual(registry.read_bytes(), b'{"local": 2}')
                candidate[rel] = b'{"upstream": 3}'
                with self.assertRaisesRegex(RuntimeError, 'both changed'):
                    deploy(root, 'third', second, installed, root / 'state')
                self.assertEqual(registry.read_bytes(), b'{"local": 2}')
                self.assertEqual(json.loads((installed / '.j-skills-managed.json').read_text())['commit'], 'second')
                del candidate[rel]
                with self.assertRaisesRegex(RuntimeError, 'both changed'):
                    deploy(root, 'removed', second, installed, root / 'state')
                self.assertFalse((root / 'state/pending.json').exists())

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
