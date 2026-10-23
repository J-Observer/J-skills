import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { sessionHealthState } from '../scripts/demand/_chatgpt_web.mjs';
import { healthFailure } from '../scripts/demand/_chatgpt_guard.mjs';

// HTMLParser supplies fixture nodes; this small DOM adapter covers the selectors used by the probe.
function state(html, url = 'https://chatgpt.com/?temporary-chat=true') {
  const parsed = spawnSync('python3', ['-c', `
from html.parser import HTMLParser
import json, sys
class Fixture(HTMLParser):
 def __init__(self):
  super().__init__(); self.nodes=[]; self.stack=[]
 def handle_starttag(self, tag, attrs):
  node=dict(tag=tag, attrs=dict(attrs), parents=[n['tag'] for n in self.stack], innerText='')
  self.nodes.append(node)
  if tag not in ('input','br','img','meta','link','hr'): self.stack.append(node)
 def handle_endtag(self, tag):
  for i in range(len(self.stack)-1,-1,-1):
   if self.stack[i]['tag']==tag: self.stack=self.stack[:i]; break
 def handle_data(self, data):
  for node in self.stack: node['innerText']+=data
p=Fixture(); p.feed(sys.stdin.read()); print(json.dumps(p.nodes))
`], { input: html, encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const nodes = JSON.parse(parsed.stdout);
  const matches = (node, selector) => {
    const parts = selector.trim().split(' ');
    const leaf = parts.pop();
    if (parts.length && !parts.every(tag => node.parents.includes(tag))) return false;
    const tag = leaf.match(/^[a-z]+/)?.[0];
    if (tag && node.tag !== tag) return false;
    return [...leaf.matchAll(/\[([^\]=*^]+)(?:(\^=|\*=|=)"([^"]*)")?\]/g)].every(([, key, op, value]) => {
      const actual = node.attrs[key];
      return actual !== undefined && (!op || (op === '=' ? actual === value : op === '^=' ? actual.startsWith(value) : actual.includes(value)));
    });
  };
  const querySelectorAll = selectors => nodes.filter(node => selectors.split(',').some(s => matches(node, s)));
  const document = { body: { innerText: nodes.find(n => n.tag === 'body')?.innerText || '' }, querySelectorAll, querySelector: s => querySelectorAll(s)[0] || null };
  return runInNewContext(`(${sessionHealthState.toString()})()`, { document, location: new URL(url) });
}

for (const [name, html, url, expected] of [
  ['history without legacy testid', '<body><nav><a href="/c/123">历史会话</a><button>账号名</button></nav><textarea></textarea></body>', undefined, null],
  ['profile signal', '<body><button data-testid="user-menu-button">账号</button></body>', undefined, null],
  ['legacy profile', '<body><button data-testid="accounts-profile-button">账号</button></body>', undefined, null],
  ['login overrides history and composer', '<body><nav><a href="/c/123">历史</a></nav><button>Log in</button><textarea></textarea></body>', undefined, 'auth'],
  ['signup button', '<body><button>免费注册</button></body>', undefined, 'auth'],
  ['login page', '<body></body>', 'https://auth.openai.com/log-in', 'auth'],
  ['unknown with composer only', '<body><textarea></textarea></body>', undefined, 'unknown'],
  ['conversation content is not login UI', '<body><article>Log in captcha</article><textarea></textarea></body>', undefined, 'unknown'],
  ['non-sidebar conversation link is insufficient', '<body><article><a href="/c/123">引用</a></article></body>', undefined, 'unknown'],
]) test(name, () => assert.equal(healthFailure(state(html, url)), expected));
