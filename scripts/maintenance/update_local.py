"""Once-daily Windows update with drift detection, backups and rollback."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

from validate import validate

HK = timezone(timedelta(hours=8))


@contextmanager
def update_lock(state_dir):
    state_dir.mkdir(parents=True, exist_ok=True)
    with (state_dir / 'update.lock').open('a+b') as handle:
        handle.write(b'0')
        handle.flush()
        handle.seek(0)
        if os.name == 'nt':
            import msvcrt
            msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == 'nt':
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle, fcntl.LOCK_UN)


def command(args, cwd, capture=True):
    result = subprocess.run(list(map(str, args)), cwd=cwd, check=True, timeout=600,
                            stdout=subprocess.PIPE if capture else None,
                            stderr=subprocess.PIPE if capture else None)
    return result.stdout.decode('utf-8').strip() if capture else ''


def git(root, *args):
    return command(['git', *args], root)


def digest(data):
    return hashlib.sha256(data.replace(b'\r\n', b'\n')).hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.tmp')
    temp.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    os.replace(temp, path)


def tree(root, ref):
    data = subprocess.check_output(['git', 'archive', '--format=zip', ref], cwd=root)
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        return {n: archive.read(n) for n in archive.namelist() if not n.endswith('/')}


def layout(files):
    skills = {}
    for name in files:
        parts = name.split('/')
        if parts[-1] == 'SKILL.md' and len(parts) in (2, 3):
            skills[parts[0]] = name
    units = set(skills) | {'platforms', 'scripts', 'docs'}
    managed = {p: b for p, b in files.items() if p.split('/')[0] in units}
    return skills, units, managed


def assert_unchanged(installed, hashes):
    drift = [p for p, expected in hashes.items()
             if not (installed / p).is_file() or digest((installed / p).read_bytes()) != expected]
    if drift:
        raise RuntimeError('Installed files have local changes; preserved: ' + ', '.join(drift[:15]))


def is_link(path):
    return path.is_symlink() or path.is_junction()


def mirror_dirs(home, installed, old_skills):
    result = []
    for dot in home.iterdir():
        if not dot.name.startswith('.') or dot.name == '.agents':
            continue
        folder = dot / 'skills'
        if not folder.is_dir() or is_link(folder):
            continue
        if any(is_link(folder / n) and (folder / n).resolve() == (installed / n).resolve()
               for n in old_skills):
            result.append(folder)
    return result


def make_link(target, link):
    if os.name == 'nt':
        # Arguments travel through JSON, never through interpolated shell code.
        env = os.environ.copy()
        env['J_SKILLS_LINK'] = json.dumps([str(target), str(link)])
        subprocess.run(['powershell.exe', '-NoProfile', '-NonInteractive', '-Command',
                        '$p=ConvertFrom-Json $env:J_SKILLS_LINK; New-Item -ItemType Junction -Path $p[1] -Target $p[0] | Out-Null'],
                       env=env, check=True, timeout=30)
    else:
        link.symlink_to(target, target_is_directory=True)


def deploy(repo, ref, base, installed, state_dir):
    files = tree(repo, ref)
    skills, units, managed = layout(files)
    assert_unchanged(installed, base['hashes'])
    old_units = set(base['units'])
    for name in units - old_units:
        if os.path.lexists(installed / name):
            raise RuntimeError(f'Unmanaged name collision: {name}')
    stamp = datetime.now(HK).strftime('%Y%m%d-%H%M%S-%f')
    backup = state_dir / 'backups' / stamp
    stage = state_dir / 'staging' / stamp
    stage.mkdir(parents=True)
    backup.mkdir(parents=True)
    for rel, data in managed.items():
        path = stage / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
    # Preserve runtime-only files (.env, local outputs, installed dependencies).
    # Retired skills stay in backups, never masquerade as current skills.
    for unit in old_units & units:
        source = installed / unit
        if not source.exists() or is_link(source):
            continue
        for folder, dirs, names in os.walk(source, followlinks=False):
            dirs[:] = [n for n in dirs if n not in ('__pycache__', '.git') and not is_link(Path(folder) / n)]
            for name in names:
                path = Path(folder) / name
                rel = path.relative_to(installed).as_posix()
                if rel in base['hashes'] or rel in managed or path.is_symlink():
                    continue
                target = stage / rel
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
    if 'agent-fleet' in units:
        before = installed / 'agent-fleet/package-lock.json'
        after = stage / 'agent-fleet/package-lock.json'
        if not (stage / 'agent-fleet/node_modules').is_dir() or not before.exists() or digest(before.read_bytes()) != digest(after.read_bytes()):
            node = Path(shutil.which('node'))
            npm = [str(node), str(node.parent / 'node_modules/npm/bin/npm-cli.js')] if os.name == 'nt' else ['npm']
            command([*npm, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], stage / 'agent-fleet', capture=False)
    assert_unchanged(stage, {p: digest(b) for p, b in managed.items()})
    assert_unchanged(installed, base['hashes'])
    mirrors = mirror_dirs(Path.home(), installed, base['skills'])
    for mirror in mirrors:
        for name in skills:
            link = mirror / name
            if os.path.lexists(link) and (not is_link(link) or link.resolve() != (installed / name).resolve()):
                raise RuntimeError(f'Unmanaged mirror collision: {link}')
    lock_path = installed.parent / '.skill-lock.json'
    old_lock = lock_path.read_bytes()
    (backup / 'skill-lock.json').write_bytes(old_lock)
    manifest_path = installed / '.j-skills-managed.json'
    previous_manifest = manifest_path.read_bytes() if manifest_path.exists() else None
    if previous_manifest:
        (backup / 'managed.json').write_bytes(previous_manifest)
    records = []
    journal = state_dir / 'pending.json'
    def move(old, new):
        new.parent.mkdir(parents=True, exist_ok=True)
        records.append([str(old), str(new)])
        write_json(journal, {'backup': str(backup), 'moves': records})
        old.rename(new)
    try:
        for unit in sorted(units | old_units):
            target = installed / unit
            if os.path.lexists(target):
                move(target, backup / 'units' / unit)
            if unit in units:
                move(stage / unit, target)
        for mirror in mirrors:
            for name in base['skills'].keys() - skills.keys():
                link = mirror / name
                if is_link(link) and link.resolve() == (installed / name).resolve():
                    move(link, backup / 'mirrors' / mirror.parent.name / name)
            for name in skills:
                link = mirror / name
                if not os.path.lexists(link):
                    # A temporary link lets the same move journal undo additions.
                    temp = stage / ('mirror-' + mirror.parent.name + '-' + name)
                    make_link(installed / name, temp)
                    move(temp, link)
        lock = json.loads(old_lock)
        for name in base['skills'].keys() - skills.keys():
            lock['skills'].pop(name, None)
        for name, skill_path in skills.items():
            entry = lock['skills'].setdefault(name, {})
            entry.update(source='J-Observer/J-skills', sourceType='github',
                         sourceUrl='https://github.com/J-Observer/J-skills.git',
                         skillPath=skill_path, skillFolderHash=git(repo, 'rev-parse', f'{ref}:{name}'),
                         updatedAt=datetime.now(timezone.utc).isoformat())
            entry.setdefault('installedAt', entry['updatedAt'])
        write_json(lock_path, lock)
        manifest = {'source': 'J-Observer/J-skills', 'commit': ref, 'skills': skills,
                    'units': sorted(units), 'hashes': {p: digest(b) for p, b in managed.items()},
                    'backup': str(backup), 'updatedAt': datetime.now(HK).isoformat()}
        write_json(manifest_path, manifest)
        assert_unchanged(installed, manifest['hashes'])
        for name, skill_path in skills.items():
            assert (installed / skill_path).is_file(), name
        write_json(backup / 'transaction.json', {'moves': records, 'commit': ref})
        journal.unlink()
        # Empty staging leftovers are kept only if a failed transaction needs them.
        if stage.resolve().is_relative_to((state_dir / 'staging').resolve()):
            shutil.rmtree(stage)
        return manifest
    except Exception:
        for old, new in reversed(records):
            old, new = Path(old), Path(new)
            if os.path.lexists(new) and not os.path.lexists(old):
                old.parent.mkdir(parents=True, exist_ok=True)
                new.rename(old)
        lock_path.write_bytes(old_lock)
        if previous_manifest:
            manifest_path.write_bytes(previous_manifest)
        elif manifest_path.exists():
            manifest_path.unlink()
        journal.unlink(missing_ok=True)
        raise


def update(args):
    repo = args.repo.resolve()
    state_dir = args.state.resolve()
    installed = Path.home() / '.agents/skills'
    state_dir.mkdir(parents=True, exist_ok=True)
    if (state_dir / 'pending.json').exists():
        raise RuntimeError('Interrupted deployment journal exists; preserve it for recovery before retrying.')
    status_path = state_dir / 'status.json'
    status = json.loads(status_path.read_text()) if status_path.exists() else {}
    today = datetime.now(HK).date().isoformat()
    if args.scheduled and status.get('checkedDate') == today:
        print('Already checked today; no network request.')
        return
    status.update(checkedDate=today, checkedAt=datetime.now(HK).isoformat(), status='checking')
    write_json(status_path, status)
    try:
        if git(repo, 'status', '--porcelain'):
            raise RuntimeError('Local working tree has uncommitted changes; update skipped.')
        if git(repo, 'branch', '--show-current') != 'main':
            raise RuntimeError('Local branch is not main; update skipped.')
        old_head = git(repo, 'rev-parse', 'HEAD')
        if not args.install_current:
            if git(repo, 'remote', 'get-url', 'origin').removesuffix('.git') != 'https://github.com/J-Observer/J-skills':
                raise RuntimeError('Unexpected origin; update skipped.')
            git(repo, 'fetch', '--no-tags', 'origin', 'main')
            target = git(repo, 'rev-parse', 'origin/main')
            git(repo, 'merge-base', '--is-ancestor', old_head, target)
        else:
            target = old_head
        marker = installed / '.j-skills-managed.json'
        if marker.exists():
            base = json.loads(marker.read_text(encoding='utf-8'))
            assert_unchanged(installed, base['hashes'])
        elif args.bootstrap_ref:
            skills, units, managed = layout(tree(repo, args.bootstrap_ref))
            # Shared resources are existing Junctions to the already-merged source.
            hashes = {p: digest(b) for p, b in managed.items() if not is_link(installed / p.split('/')[0])}
            base = {'skills': skills, 'units': sorted(units), 'hashes': hashes}
        else:
            raise RuntimeError('Missing installation baseline; initialize explicitly once.')
        if base.get('commit') == target and old_head == target:
            status.update(status='current', commit=target)
        else:
            with tempfile.TemporaryDirectory(prefix='j-skills-check-') as scratch:
                candidate = Path(scratch) / 'repo'
                command(['git', 'clone', '--shared', '--no-checkout', str(repo), str(candidate)], repo)
                git(candidate, 'checkout', '--detach', target)
                validate(candidate)
            if git(repo, 'status', '--porcelain') or git(repo, 'rev-parse', 'HEAD') != old_head:
                raise RuntimeError('Source changed during validation; update skipped.')
            git(repo, 'branch', 'backup/local-' + datetime.now(HK).strftime('%Y%m%d-%H%M%S'), old_head)
            git(repo, 'merge', '--ff-only', target)
            try:
                manifest = deploy(repo, target, base, installed, state_dir)
            except Exception:
                # Only undo our own fast-forward when no concurrent edits appeared.
                if target != old_head and not git(repo, 'status', '--porcelain') and git(repo, 'rev-parse', 'HEAD') == target:
                    git(repo, 'reset', '--keep', old_head)
                raise
            status.update(status='updated', commit=target, backup=manifest['backup'])
        status.pop('error', None)
        print(json.dumps(status, ensure_ascii=False))
    except Exception as error:
        status.update(status='failed', error=str(error))
        raise
    finally:
        write_json(status_path, status)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument('--state', type=Path, default=Path(os.environ.get('LOCALAPPDATA', str(Path.home()))) / 'J-skills')
    parser.add_argument('--scheduled', action='store_true')
    parser.add_argument('--install-current', action='store_true')
    parser.add_argument('--bootstrap-ref')
    args = parser.parse_args()
    with update_lock(args.state):
        update(args)
