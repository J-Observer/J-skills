#!/usr/bin/env node
/**
 * SKILL.md is YAML frontmatter + an XML body. Both halves have a way of
 * breaking that a human eye slides right past:
 *
 *  - a bare `<session>` or `--tab <id>` written in prose parses as a tag and
 *    silently unbalances the document from that point on;
 *  - a <ref file="..."> or a <law-ref id="..."> that points at something that
 *    was renamed still *looks* fine, and only fails when a reader follows it.
 *
 * Both are cheap to check and expensive to discover later, so this runs as a
 * gate. Exit 0 means the body is well-formed and every pointer resolves.
 *
 *   node scripts/validate-skill-xml.mjs [path/to/SKILL.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helpGuard } from './opencli-core.mjs';
helpGuard(import.meta.url);

const here = path.dirname(fileURLToPath(import.meta.url));
const skillDir = path.resolve(here, '..');
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(skillDir, 'SKILL.md');
const root = path.dirname(file);

const raw = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const problems = [];

// --- frontmatter ------------------------------------------------------------
// The loader reads this for discovery, so it stays YAML no matter how the body
// is written. A body-format change that eats the frontmatter makes the Skill
// undiscoverable rather than merely malformed, which is the worse failure.
const fm = raw.match(/^---\n([\s\S]*?)\n---\n/);
if (!fm) problems.push('frontmatter: missing or malformed YAML block at top of file');
else {
  for (const key of ['name', 'description']) {
    if (!new RegExp(`^${key}:\\s*\\S`, 'm').test(fm[1])) problems.push(`frontmatter: missing \`${key}\``);
  }
}
const body = fm ? raw.slice(fm[0].length) : raw;

// --- XML well-formedness ----------------------------------------------------
// CDATA and comments are lifted out first; everything inside them is opaque by
// definition and checking it would produce false alarms on shell snippets.
const masked = body
  .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => ' '.repeat(m.length))
  .replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length));

const lineAt = (idx) => masked.slice(0, idx).split('\n').length;
const stack = [];
const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:\s[^<>]*?)?)(\/?)>/g;
let m;
while ((m = tagRe.exec(masked))) {
  const [, closing, name, , selfClose] = m;
  if (selfClose) continue;
  if (closing) {
    const open = stack.pop();
    if (!open) problems.push(`xml:${lineAt(m.index)}: stray closing </${name}>`);
    else if (open.name !== name) problems.push(`xml:${lineAt(m.index)}: </${name}> closes <${open.name}> opened at line ${open.line}`);
  } else {
    stack.push({ name, line: lineAt(m.index) });
  }
}
for (const open of stack) problems.push(`xml:${open.line}: <${open.name}> is never closed`);

// A `<` that did not parse as one of the tags above is prose that needs
// escaping. This is the failure that actually happens, so name it precisely.
const bareLt = [...masked.matchAll(/</g)].filter((x) => {
  tagRe.lastIndex = x.index;
  const t = new RegExp(tagRe.source).exec(masked.slice(x.index));
  return !(t && t.index === 0);
});
for (const x of bareLt.slice(0, 10)) {
  problems.push(`xml:${lineAt(x.index)}: bare "<" in prose — escape it as &lt; (context: ${JSON.stringify(masked.slice(x.index, x.index + 40))})`);
}

// --- pointers resolve -------------------------------------------------------
const refs = new Set([...body.matchAll(/<ref file="([^"]+)"/g)].map((x) => x[1]));
for (const r of refs) if (!fs.existsSync(path.join(root, r))) problems.push(`ref: ${r} does not exist`);

const paths = new Set([
  ...body.matchAll(/((?:scripts|data|references)\/[A-Za-z0-9_.\-]+\.(?:mjs|json|js|sh|md))\b/g),
].map((x) => x[1]));
for (const p of paths) {
  if (p.includes('*')) continue;
  if (!fs.existsSync(path.join(root, p))) problems.push(`path: ${p} referenced but not found`);
}

const ids = (re) => new Set([...body.matchAll(re)].map((x) => x[1]));
const laws = ids(/<law id="([^"]+)"/g);
for (const r of ids(/<law-ref id="([^"]+)"/g)) if (!laws.has(r)) problems.push(`law-ref: no <law id="${r}">`);
const flows = ids(/<workflow id="([^"]+)"/g);
for (const r of ids(/<workflow-ref id="([^"]+)"/g)) if (!flows.has(r)) problems.push(`workflow-ref: no <workflow id="${r}">`);

// --- report -----------------------------------------------------------------
if (problems.length) {
  console.error(`✗ ${path.relative(process.cwd(), file)} — ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ${p}`);
  if (problems.some((p) => /^xml:/.test(p))) {
    console.error(`
  Hint: one unescaped "<" in prose unbalances everything after it, so a long
  cascade of mismatched tags usually has a single cause. Fix the FIRST xml line
  above and re-run before touching any of the others — a phrase like
  \`--tab <id>\` or \`browser <session>\` needs &lt; / &gt;, or wrap the block
  in CDATA if it is a command you want to keep copy-pasteable.`);
  }
  process.exit(1);
}
const stats = { lines: raw.split('\n').length, laws: laws.size, workflows: flows.size, refs: refs.size, paths: paths.size };
console.log(`✓ SKILL.md well-formed — ${stats.lines} lines · ${stats.laws} laws · ${stats.workflows} workflows · ${stats.refs + stats.paths} pointers, all resolving`);
