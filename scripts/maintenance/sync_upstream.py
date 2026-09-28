"""Daily GitHub sync. Conflicts or failed gates leave main unchanged."""
import json
import os
from pathlib import Path
import subprocess
import sys
from validate import validate

ROOT = Path(__file__).resolve().parents[2]
REPO = 'J-Observer/J-skills'
TITLE = 'Upstream sync needs attention'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT, text=True, stderr=subprocess.STDOUT).strip()


def api(endpoint, payload=None):
    args = ['gh', 'api', f'repos/{REPO}/{endpoint}']
    if payload is not None:
        args += ['--method', 'PATCH' if endpoint.startswith('issues/') else 'POST', '--input', '-']
    result = subprocess.run(args, input=json.dumps(payload) if payload is not None else None,
                            text=True, capture_output=True, check=True)
    return json.loads(result.stdout) if result.stdout else None


def attention(body=None):
    issues = api('issues?state=open&per_page=100')
    existing = next((i for i in issues if i['title'] == TITLE and i['user']['login'] == 'github-actions[bot]'), None)
    if body:
        if existing:
            api(f"issues/{existing['number']}", {'body': body})
        else:
            api('issues', {'title': TITLE, 'body': body})
    elif existing:
        api(f"issues/{existing['number']}", {'state': 'closed', 'state_reason': 'completed'})


def main():
    before = git('rev-parse', 'HEAD')
    git('fetch', '--no-tags', 'https://github.com/yan-labs/yan-skills.git', 'main')
    upstream = git('rev-parse', 'FETCH_HEAD')
    if subprocess.run(['git', 'merge-base', '--is-ancestor', upstream, 'HEAD'], cwd=ROOT).returncode == 0:
        print(f'Already contains upstream {upstream}')
        if os.environ.get('GITHUB_EVENT_NAME') == 'workflow_dispatch':
            validate(ROOT)
        attention()
        return
    git('config', 'user.name', 'github-actions[bot]')
    git('config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com')
    try:
        git('merge', '--no-ff', '--no-edit', upstream)
        validate(ROOT)
        subprocess.run(['gh', 'auth', 'setup-git'], check=True)
        # Normal push rejects a concurrent update; never force-push main.
        git('push', 'origin', 'HEAD:refs/heads/main')
    except Exception as error:
        conflicts = git('diff', '--name-only', '--diff-filter=U')
        run_url = f"https://github.com/{REPO}/actions/runs/{os.environ.get('GITHUB_RUN_ID', '')}"
        detail = error.output if isinstance(error, subprocess.CalledProcessError) and error.output else str(error)
        attention(f'Automatic synchronization stopped; main was not overwritten.\n\n'
                  f'Previous commit: `{before}`\nUpstream: `{upstream}`\n\n'
                  f'Conflicts:\n```\n{conflicts or "none; see validation log"}\n```\n\n'
                  f'Error:\n```\n{str(detail)[-4000:]}\n```\n\n[Workflow log]({run_url})')
        raise
    attention()
    after = git('rev-parse', 'HEAD')
    summary = f'Updated `{before}` → `{after}`; includes upstream `{upstream}`. Offline checks passed.\n'
    print(summary)
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        Path(os.environ['GITHUB_STEP_SUMMARY']).write_text(summary, encoding='utf-8')


if __name__ == '__main__':
    main()
