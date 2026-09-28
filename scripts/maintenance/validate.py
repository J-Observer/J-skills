"""Offline update gate, shared by GitHub and the Windows installer."""
import os
from pathlib import Path
import shutil
import subprocess
import sys


def run(args, root):
    env = {k: v for k, v in os.environ.items() if k not in ('GH_TOKEN', 'GITHUB_TOKEN')}
    print('+ ' + ' '.join(map(str, args)), flush=True)
    subprocess.run(list(map(str, args)), cwd=root, env=env, check=True, timeout=600)


def validate(root):
    import yaml
    root = Path(root).resolve()
    paths = subprocess.check_output(['git', 'ls-files', '*SKILL.md'], cwd=root, text=True).splitlines()
    names = set()
    for rel in paths:
        content = (root / rel).read_text(encoding='utf-8-sig')
        metadata = yaml.safe_load(content.split('---', 2)[1])
        assert metadata.get('name') and metadata.get('description'), rel
        assert metadata['name'] not in names, f'duplicate skill: {rel}'
        names.add(metadata['name'])
    print(f'Validated {len(names)} skill metadata records', flush=True)
    node = Path(shutil.which('node'))
    npm = [str(node), str(node.parent / 'node_modules/npm/bin/npm-cli.js')] if os.name == 'nt' else ['npm']
    run([*npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', 'agent-fleet'], root)
    tests = [str(p.relative_to(root)) for group in ('rankup', 'backlink', 'opencli')
             for p in sorted((root / group / 'tests').glob('*.test.mjs'))]
    run(['node', '--test', '--test-reporter=spec', *tests], root)
    for name in ('verdict-test', 'control-unit-test', 'shortcuts-test'):
        run(['node', f'agent-fleet/test/{name}.mjs'], root)
    run([sys.executable, '-m', 'unittest', 'discover', '-s', 'scripts/maintenance/tests', '-v'], root)
    run([sys.executable, '-m', 'unittest', 'discover', '-s', 'skill-link-check/tests', '-v'], root)


if __name__ == '__main__':
    validate(Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parents[2])
