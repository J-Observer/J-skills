"""Brief assembly only; fleet owns execution and scheduling."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import time

BLOCKS = Path(__file__).resolve().parents[1] / 'skill/templates/blocks'
KINDS = {'code': ('(a) Codex 编码', ['code']), 'review': ('Codex 只读审查', ['code', '--review']),
         'research': ('Codex 调研', ['code']), 'copy': ('Gemini 文案', ['copy']),
         'grok': ('Grok 调研', ['grok']), 'haiku': ('Claude Haiku', ['haiku']), 'sonnet': ('Claude Sonnet', ['sonnet'])}
AUTH = ['local', 'readonly-web', 'deploy-prod', 'paid', 'review']
PITFALLS = ['node-proxy', 'zsh', 'pnpm-entry', 'local-preview', 'playwright-clean', 'shared-tree', 'secrets', 'fleet-bg', 'ssr-check']


def block(name, values=None):
    text = (BLOCKS / (name + '.md')).read_text().strip()
    for key, value in (values or {}).items():
        text = text.replace('{' + key + '}', value)
    return text


def rule():
    stored = block('rule-sentence')
    source = Path.home() / '.claude/CLAUDE.md'
    if source.exists():
        match = re.search(r'禁止单纯转发，允许分发子步骤：[^\n]+?最终给出真正的结论作为你的最终答案', source.read_text())
        if not match or match[0] != stored:
            raise ValueError('规则句与 ~/.claude/CLAUDE.md 不一致，请先同步 rule-sentence.md。')
    return stored


def lint(text, kind='code'):
    errors = []
    first = text.splitlines()[0] if text else ''
    if not first.startswith('归类：') or '理由：' not in first:
        errors.append('第一行必须以「归类：」开头并含「理由：」。')
    if not re.search(r'^REPORT: /[^\n]+$', text, re.M):
        errors.append('缺少 REPORT: <绝对路径> 行。')
    if rule() not in text:
        errors.append('缺少逐字规则句。')
    if re.search(r'sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{20,}', text):
        errors.append('发现疑似密钥字面量（已隐藏）。')
    for line in text.splitlines():
        # 只检查启动命令；禁令和标明的错误示范是说明文字。
        if re.search(r'禁止|不加|不要|错误示范|绝不|不得', line):
            continue
        if re.search(r'(?:^|[\s`$;(])(?:fleet|fleet-go)\s+(?:code|copy|grok|haiku|sonnet|run|new)\b|^\s*(?:\$\s*)?`?(?:nohup|node|npm|pnpm|python3?|bash|sh)\s+', line):
            if re.search(r'\b(?:nohup|setsid|disown)\b|(?<![&>])&(?![&\d])', line):
                errors.append('发现脱离启动命令；请使用工具 run_in_background。')
    if kind == 'code' and not all(word in text for word in ['授权覆盖', '允许读写', '禁止']):
        print('警告：code brief 缺少授权覆盖或允许读写/禁止小节。', file=sys.stderr)
    return errors


def checked(text, kind):
    errors = lint(text, kind)
    if errors:
        raise ValueError('\n'.join(errors))


def command(meta):
    return ['fleet', *KINDS[meta['kind']][1], meta['brief'], '--name', meta['name'], '--report', meta['report']]


def launch(meta):
    os.execvp('fleet', command(meta))


def running():
    result = subprocess.run(['fleet', 'status', '--running', '--json'], capture_output=True, text=True)
    if result.returncode:
        raise ValueError('无法读取 fleet 运行状态。')
    rows = json.loads(result.stdout)
    if not isinstance(rows, list):
        raise ValueError('fleet status 返回格式不是数组。')
    return rows


def locate(name):
    matches = list((Path.home() / '.agent-reports').glob('*/' + name + '.brief.md'))
    if len(matches) != 1:
        raise ValueError('找不到唯一同名 brief，请换用唯一名称（跨日期重名也会歧义）。')
    path = matches[0]
    meta = json.loads(path.with_suffix('.json').read_text())
    return path, meta


def amend(args):
    path, meta = locate(args.name)
    original = path.read_text()
    if re.search(r'^## 【修订 \d+（[^\n]+）】\n' + re.escape(args.message) + r'(?=\n\n)', original, re.M):
        print('相同修订已存在，未重复插入。')
    else:
        numbers = [int(n) for n in re.findall(r'^## 【修订 (\d+)（', original, re.M)]
        lines = original.splitlines(keepends=True)
        stamp = datetime.datetime.now().isoformat(timespec='seconds')
        revised = ''.join(lines[:2]) + f'\n## 【修订 {max(numbers, default=0) + 1}（{stamp}）】\n{args.message}\n\n' + ''.join(lines[2:])
        checked(revised, meta['kind'])
        path.write_text(revised)
        print(f'已修订：{path}', flush=True)
    if not args.say and not args.restart:
        return
    matches = [r for r in running() if r.get('state', r.get('status')) == 'running'
               and (r.get('briefPath') == str(path) or r.get('name') == args.name)]
    if len(matches) != 1:
        raise ValueError('找不到唯一运行中的 run；修订已保留，未发送或重启。')
    run = matches[0]
    if args.say:
        result = subprocess.run(['fleet', 'say', run['runId'], args.message])
        if result.returncode:
            raise ValueError('fleet say 失败（Codex 不支持插话）；修订已保留，未 stop、未重派。确需重来用 --restart。')
        return
    subprocess.run(['fleet', 'stop', run['runId']], check=True)
    deadline = time.monotonic() + 5
    # 同时核验状态和 Codex 残留；只观察，不按名字强杀。
    while True:
        active = any(r['runId'] == run['runId'] for r in running())
        result = subprocess.run(['pgrep', '-fl', 'codex exec'], capture_output=True, text=True)
        if result.returncode not in (0, 1):
            raise ValueError('无法核验 Codex 残留；已停止，未重派。')
        markers = [args.name, str(path)]
        if run.get('cwd'):
            markers.append(run['cwd'])
        leftover = any(any(marker in line for marker in markers) for line in result.stdout.splitlines())
        if not active and not leftover:
            break
        if time.monotonic() >= deadline:
            raise ValueError('进程或状态仍有残留，请核验后重试；未强杀其它进程，未重派。')
        time.sleep(0.2)
    checked(path.read_text(), meta['kind'])
    launch(meta)


def new(args):
    day = datetime.date.today().isoformat()
    folder = Path.home() / '.agent-reports' / day
    path = folder / (args.name + '.brief.md')
    if path.exists():
        raise ValueError('同名 brief 已存在，拒绝覆盖；请用 amend 或换名。')
    report = str(Path(args.report).expanduser().absolute()) if args.report else str(folder / (args.name + '.md'))
    auth = args.auth.split(',')
    if any(a not in AUTH for a in auth):
        raise ValueError('未知授权块。可用：' + ','.join(AUTH))
    if 'paid' in auth and not args.budget:
        raise ValueError('paid 必须提供 --budget（上限与重试次数）。')
    pitfalls = args.pitfalls.split(',') if args.pitfalls is not None else (['node-proxy', 'zsh', 'secrets', 'shared-tree'] if args.kind == 'code' else ['secrets', 'fleet-bg'])
    if args.pitfalls is None and 'deploy-prod' in auth:
        pitfalls.append('pnpm-entry')
        pitfalls.extend(p.stem[8:] for p in BLOCKS.glob('pitfall-deploy-*.md'))
    if any(p not in PITFALLS and not (BLOCKS / ('pitfall-' + p + '.md')).exists() for p in pitfalls if p):
        raise ValueError('未知已知坑块。')
    values = {'NAME': args.name, 'REPORT': report, 'BUDGET': args.budget or '未授权付费', 'DATE': day}
    body = Path(args.body).read_text() if args.body else (sys.stdin.read() if not sys.stdin.isatty() else '')
    if not args.goal and not body.strip():
        raise ValueError('请提供 --goal、--body 或 stdin 正文。')
    parts = [f'归类：{KINDS[args.kind][0]}；理由：{args.why or KINDS[args.kind][0] + "任务，按既有路由执行"}\nREPORT: {report}', block('style-sol', values),
             '## 授权覆盖\n' + '\n\n'.join(block('auth-' + a, values) for a in dict.fromkeys(auth))]
    if args.goal:
        parts.append('## 目标\n' + args.goal)
    if body.strip():
        parts.append(body.strip())
    writes = [report, '/tmp/' + args.name + '/', *(args.write or [])]
    parts.append('## 允许读写/禁止\n允许写：\n' + '\n'.join('- ' + p for p in dict.fromkeys(writes)) + '\n只读：\n' + '\n'.join('- ' + p for p in (args.read or [])) + '\n禁止：' + (args.forbid or '越界、未授权部署、提交/推送、付费、打印密钥。'))
    parts.append('## 已知坑\n' + '\n\n'.join(block('pitfall-' + p, values) for p in dict.fromkeys(pitfalls) if p))
    parts.extend(['## 验收\n' + block('accept-boilerplate', values) + '\n\n' + block('report-template', values), rule()])
    text = '\n\n'.join(parts) + '\n'
    checked(text, args.kind)
    meta = {'kind': args.kind, 'name': args.name, 'brief': str(path), 'report': report}
    if args.dry_run:
        print(text, end='')
        print('\n将执行：' + shlex.join(command(meta)), file=sys.stderr)
        return
    folder.mkdir(parents=True, exist_ok=True)
    with path.open('x') as file:
        file.write(text)
    path.with_suffix('.json').write_text(json.dumps(meta, ensure_ascii=False) + '\n')
    if args.no_launch:
        print(f'已生成：{path}')
    else:
        launch(meta)


def main():
    parser = argparse.ArgumentParser(description='fleet-go：短参数组装标准 brief；前台执行 fleet。')
    sub = parser.add_subparsers(dest='action', required=True)
    p = sub.add_parser('new')
    p.add_argument('name')
    p.add_argument('--kind', choices=KINDS, default='code')
    for option in ['why', 'goal', 'body', 'budget', 'forbid', 'pitfalls', 'report']:
        p.add_argument('--' + option)
    p.add_argument('--auth', default='local')
    for option in ['write', 'read']:
        p.add_argument('--' + option, nargs='+', action='extend')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--dry-run', action='store_true')
    group.add_argument('--no-launch', action='store_true')
    p = sub.add_parser('amend')
    p.add_argument('name')
    p.add_argument('message')
    group = p.add_mutually_exclusive_group()
    group.add_argument('--say', action='store_true')
    group.add_argument('--restart', action='store_true')
    p = sub.add_parser('lint')
    p.add_argument('brief')
    p.add_argument('--kind', choices=KINDS, default='code')
    sub.add_parser('status')
    args = parser.parse_args()
    if hasattr(args, 'name') and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_-]*', args.name):
        raise ValueError('名称只能包含字母、数字、下划线与连字符。')
    if args.action == 'new':
        new(args)
    elif args.action == 'amend':
        amend(args)
    elif args.action == 'lint':
        checked(Path(args.brief).read_text(), args.kind)
        print('lint 通过。')
    else:
        rows = running()
        for r in rows:
            warning = '⚠ ' if r.get('launchDetached') else ''
            print(f"{warning}{r['runId'][-16:]} {r.get('status', '?')} {r.get('duration', '?')} {Path(r.get('briefPath') or r.get('name') or '?').name}")
            if warning:
                print('请用 fleet wait ' + r['runId'] + ' 挂上通知。')
        if not rows:
            print('没有运行中的任务。')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError) as error:
        # 不回显正文、命令参数或状态内容，避免错误输出带出秘密。
        print('错误：' + (str(error) if isinstance(error, ValueError) else '文件或子命令操作失败，请核验路径和权限。'), file=sys.stderr)
        sys.exit(1)
