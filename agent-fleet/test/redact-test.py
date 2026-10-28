#!/usr/bin/env python3
"""Only synthetic, runtime-assembled fixtures; never print unfiltered failures."""
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
BIN = ROOT / 'bin'
env = {**os.environ, 'PATH': str(BIN) + os.pathsep + os.environ['PATH']}
checks = 0


def check(condition, label):
    global checks
    if not condition:
        raise AssertionError(label)
    checks += 1


def run(text, *args):
    return subprocess.run(['redact', *args], input=text, text=True,
                          capture_output=True, env=env)


def main():
    secret = 'fake' + '-value-for-redaction'
    keys = ['password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key',
            'access_key', 'private_key', 'credential', 'auth']
    lines = []
    for key in keys:
        for name in (key, 'PREFIX_' + key.upper()):
            lines.extend([name + '=' + secret, '"' + name + '": "' + secret + '",',
                          name + ": '" + secret + "'"])
    for scheme in ('redis', 'rediss', 'amqp', 'amqps', 'postgres', 'postgresql',
                   'mysql', 'mongodb', 'mongodb+srv', 'https'):
        lines.append(scheme + '://' + 'fake-user' + ':' + secret + '@localhost/db')
    database_schemes = ('redis', 'rediss', 'amqp', 'amqps', 'postgres', 'postgresql',
                        'mysql', 'mongodb', 'mongodb+srv')
    for scheme in database_schemes:
        for username in ('', 'fake-user'):
            for password in (secret, 'fake%25value', 'fake%40value', 'fake%25%40value'):
                prefix = scheme + '://' + username + ':'
                url = prefix + password + '@localhost:6379/db'
                check(run(url).stdout == prefix + '<redacted:password>@localhost:6379/db',
                      'database URL password masked with authority preserved')
    aws = ['AKIA' + 'FAKE000000000000', 'ASIA' + 'FAKE000000000000']
    cloud_ids = [(prefix + 'Fake0000000000000000', kind)
                 for prefix, kind in [('LTAI', 'aliyun_access_key'), ('AKID', 'tencent_secret_id')]]
    cloud_ids += [(value, 'aws_access_key') for value in aws]
    for value, kind in cloud_ids:
        for prefix, suffix in [('', ''), ('error: ', ' invalid'),
                               ('{"AccessKeyId":"', '"}'),
                               ('AccessKeyId=', '&Action=GetCallerIdentity'),
                               ('AccessKeyId%3D', '%26Action%3DGetCallerIdentity'),
                               ('AccessKeyId%3d', '%26Action%3dGetCallerIdentity')]:
            check(run(prefix + value + suffix).stdout ==
                  prefix + '<redacted:' + kind + '>' + suffix,
                  'cloud key masked with surrounding structure preserved')
        for ordinary_value in ('word' + value, value[:4] + 'ordinary'):
            check(run(ordinary_value).stdout == ordinary_value, 'cloud-like ordinary word preserved')
    bearer = 'fake' + '-bearer-value'
    jwt = '.'.join(['eyJ' + 'mYWtl', 'ZmFrZQ', 'ZmFrZQ'])
    random_value = ('Fake0' + 'aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT')
    base64_value = random_value[:16] + '/' + random_value[16:] + '='
    pem_begin = '-----BEGIN ' + 'RSA PRIVATE KEY-----'
    pem_end = '-----END ' + 'RSA PRIVATE KEY-----'
    pem_body = 'fake' + '-private-body'
    lines += aws + ['Bearer ' + bearer, jwt, random_value, base64_value,
                    pem_begin, pem_body, pem_end]
    text = '\n'.join(lines) + '\n'
    result = run(text)
    check(result.returncode == 0, 'redact exit')
    output = result.stdout
    for value in [secret, *aws, bearer, jwt, random_value, base64_value, pem_body]:
        check(value not in output, 'synthetic credential removed')
    check(len(text.splitlines()) == len(output.splitlines()), 'line count preserved')
    for key in keys:
        check(key + '=<redacted:' in output, 'assignment name preserved')
    check('https://fake-user:<redacted:password>@localhost/db' in output,
          'URL password masked')
    ordinary = '\n'.join(['PATH=/usr/local/bin:/bin', 'file=release-2026-Final.tar.gz',
                           'digest=sha256:' + 'abcdef0123456789' * 4,
                           'url=https://example.com/files/report.json',
                           'url=https://example.com:8080/path',
                           'url=https://fake-user@example.com/db', 'port=8080', '', 'tail'])
    check(run(ordinary).stdout == ordinary, 'ordinary configuration byte-for-byte')
    check(run('port=8080\r\n\r\n').stdout == 'port=8080\n\n', 'CRLF subprocess text translation')
    raw = subprocess.run(['redact'], input=b'port=8080\r\n\r\n', capture_output=True, env=env)
    check(raw.stdout == b'port=8080\r\n\r\n', 'CRLF bytes preserved')
    check(run(output).stdout == output, 'redaction idempotent')
    check(random_value not in run('opaque=' + random_value).stdout, 'random secret under unknown key')
    check(base64_value not in run('opaque=' + base64_value).stdout, 'base64 secret under unknown key')
    check(run('path=/Users/fake/ProjectA1234567890LongDirectoryName').stdout ==
          'path=/Users/fake/ProjectA1234567890LongDirectoryName', 'long ordinary path preserved')
    with tempfile.TemporaryDirectory(prefix='redact-', dir=os.environ.get('TMPDIR', '/tmp')) as directory:
        fixture = Path(directory) / 'fixture.conf'
        fixture.write_text('before=normal\n' + 'password' + '=' + secret + '\nafter=normal\n' +
                           pem_begin + '\n' + pem_body + '\n' + pem_end + '\n')
        (Path(directory) / '.env').write_text('token' + '=' + secret + '\n')
        (Path(directory) / '.gitignore').write_text('.env\n')
        hidden = subprocess.run(['safe-grep', 'token', directory], capture_output=True, text=True, env=env)
        check(hidden.returncode == 0 and '.env:1:token=<redacted:token>' in hidden.stdout
              and secret not in hidden.stdout, 'hidden ignored configuration included')
        grep = subprocess.run(['safe-grep', 'password|' + pem_body, directory],
                              capture_output=True, text=True, env=env)
        check(grep.returncode == 0, 'safe-grep success')
        check(secret not in grep.stdout and pem_body not in grep.stdout, 'safe-grep masked')
        check(len(grep.stdout.splitlines()) == 2, 'safe-grep zero context')
        check(':2:password=<redacted:password>' in grep.stdout, 'safe-grep line number')
        check(':5:<redacted:private_key>' in grep.stdout, 'PEM body-only match masked')
        check(subprocess.run(['safe-grep', 'absent', directory], capture_output=True, env=env).returncode == 1,
              'safe-grep no match status')
        failure = subprocess.run(['safe-grep', '[', directory], capture_output=True, text=True, env=env)
        check(failure.returncode == 2 and '[' not in failure.stderr, 'safe-grep errors suppressed')
        print('假凭据输出示例（已脱敏）：')
        print('\n'.join(output.splitlines()[-10:]))
        print('普通配置输出（原样）：')
        print(ordinary)
        print('safe-grep 输出（仅命中行）：')
        print(grep.stdout, end='')
    print(f'PASS: {checks} checks')


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('FAIL:', str(error) if isinstance(error, AssertionError) else type(error).__name__, '(fixture values suppressed)')
        raise SystemExit(1)
