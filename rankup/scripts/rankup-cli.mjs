#!/usr/bin/env node
/** Rankup catalog and evidence-capture wrapper. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecretKey } from '../../backlink/scripts/tools-share-evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalogFile = path.join(here, '../data/provider-capabilities.json');
const evidenceCli = path.join(here, '../../backlink/scripts/tools-share-evidence.mjs');
const providers = new Set(['semrush', 'similarweb']);
const manifestFields = new Set(['id', 'provider', 'report', 'domain', 'keyword', 'db', 'url', 'path', 'pageKind', 'module', 'label', 'status', 'receiptPath', 'dataCompleteness']);
const catalogViews = new Set(['--json', '--modules', '--gaps']);
const usage = `Usage:
  rankup catalog [semrush|similarweb] [--json|--modules|--gaps]
  rankup capture <provider> <report> [evidence options]
  rankup run <provider> <report> [evidence options]
  rankup audit <provider> --manifest <json> --out-dir <dir> [--resume] [--accept-bounded] [--dry-run]`;

function fail(message) { throw new Error(message); }
function provider(value) {
  const name = String(value || '').toLowerCase();
  if (!providers.has(name)) fail('Provider must be semrush or similarweb.');
  return name;
}
function flags(argv, allowed) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || !allowed.has(token)) fail(`Unknown option: ${token}`);
    const key = token.slice(2);
    if (['resume', 'accept-bounded', 'dry-run'].includes(key)) {
      if (result[key]) fail(`Duplicate option: ${token}`);
      result[key] = true;
      continue;
    }
    const value = argv[++index];
    if (!value || value.startsWith('--') || result[key] !== undefined) fail(`Option ${token} requires one value.`);
    result[key] = value;
  }
  return result;
}
function child(args) {
  return new Promise((resolve) => {
    const subprocess = spawn(process.execPath, [evidenceCli, ...args], { stdio: 'inherit' });
    subprocess.once('error', (error) => resolve({ code: 1, error: error.message }));
    subprocess.once('close', (code) => resolve({ code: code ?? 1 }));
  });
}
function isDomain(value) { return /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(value); }
function hashParameters(hash) {
  const value = String(hash || '');
  const query = value.indexOf('?');
  return new URLSearchParams(query >= 0 ? value.slice(query + 1) : (value.startsWith('#') && value.includes('=') ? value.slice(1) : ''));
}
function validateParameters(parameters, entry, selectedProvider, source) {
  for (const [name, value] of parameters) {
    if (isSecretKey(name)) fail(`Manifest entry ${entry.id} ${source} contains a sensitive query or hash key.`);
    if (selectedProvider === 'similarweb' && name.toLowerCase() === 'key' && !isDomain(value)) fail(`Manifest entry ${entry.id} Similarweb key must be a domain.`);
  }
}
function safeCustom(entry, selectedProvider) {
  if (entry.url !== undefined) {
    let url;
    try { url = new URL(entry.url); } catch { fail(`Manifest entry ${entry.id} has an invalid url.`); }
    const origin = new URL(selectedProvider === 'semrush' ? (process.env.TOOLS_SHARE_APP_ORIGIN_SEMRUSH || 'https://semrush.example.com') : (process.env.TOOLS_SHARE_APP_ORIGIN || 'https://similarweb.example.com')).origin;
    if (url.origin !== origin) fail(`Manifest entry ${entry.id} url must use the selected provider origin.`);
    validateParameters(url.searchParams, entry, selectedProvider, 'url');
    validateParameters(hashParameters(url.hash), entry, selectedProvider, 'url');
  }
  if (entry.path !== undefined) {
    if ((!entry.path.startsWith('/') && !entry.path.startsWith('#/')) || entry.path.includes('://') || entry.path.startsWith('//')) fail(`Manifest entry ${entry.id} has an invalid path.`);
    const pathUrl = new URL(entry.path, 'https://local.invalid');
    validateParameters(pathUrl.searchParams, entry, selectedProvider, 'path');
    validateParameters(hashParameters(pathUrl.hash), entry, selectedProvider, 'path');
  }
}
function entryArgs(entry, base) {
  // 不转发 --session。这个 CLI 只服务 semrush / similarweb 两个配额站，
  // 而底层脚本会把它们收敛到固定会话名（semrush-nav / similarweb-nav）——
  // 会话名就是并发度，同时加载会触发站点上限。转发只会让底层对**每一个 entry**
  // 打一行「已忽略 --session」的 stderr，把真正的输出淹掉。
  const args = ['--tool', base.provider, '--report', entry.report, '--out-dir', base.outDir];
  for (const key of ['domain', 'keyword', 'db', 'url', 'path']) if (entry[key] !== undefined) args.push(`--${key}`, String(entry[key]));
  if (entry.pageKind !== undefined) args.push('--page-kind', entry.pageKind);
  if (base.resume) args.push('--resume');
  if (base.acceptBounded) args.push('--accept-bounded');
  return args;
}
function validateManifest(value, selectedProvider) {
  if (!Array.isArray(value)) fail('Manifest must be a JSON array.');
  const ids = new Set();
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`Manifest entry ${index} must be an object.`);
    for (const key of Object.keys(entry)) if (!manifestFields.has(key)) fail(`Manifest entry ${index} has unsupported field: ${key}`);
    entry = { ...entry, report: entry.report || (entry.url || entry.path ? 'custom' : '') };
    if (typeof entry.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/.test(entry.id) || ids.has(entry.id)) fail(`Manifest entry ${index} has an invalid or duplicate id.`);
    ids.add(entry.id);
    if (provider(entry.provider) !== selectedProvider) fail(`Manifest entry ${entry.id} provider must be ${selectedProvider}.`);
    if (typeof entry.report !== 'string' || !/^[a-z0-9][a-z0-9-]{0,80}$/.test(entry.report)) fail(`Manifest entry ${entry.id} has an invalid report.`);
    for (const key of ['domain', 'keyword', 'db', 'url', 'path', 'pageKind']) if (entry[key] !== undefined && (typeof entry[key] !== 'string' || !entry[key])) fail(`Manifest entry ${entry.id} has an invalid ${key}.`);
    for (const key of ['module', 'label', 'status', 'receiptPath', 'dataCompleteness']) if (entry[key] !== undefined && typeof entry[key] !== 'string') fail(`Manifest entry ${entry.id} has an invalid ${key}.`);
    safeCustom(entry, selectedProvider);
    return entry;
  });
}
function printModules(name, capability) {
  const modules = capability.modules || [];
  const pages = modules.reduce((total, module) => total + (Number(module.pages) || 0), 0);
  console.log(`${name}: ${modules.length} modules, ${pages} pages`);
  for (const module of modules) {
    const marks = [`${Number(module.pages) || 0}p`];
    if (module.observed === false) marks.push('not-observed');
    if (module.note) marks.push(module.note);
    console.log(`  ${module.name} [${marks.join('; ')}]`);
    for (const example of module.examples || []) console.log(`    - ${example}`);
  }
}
function printGaps(name, capability) {
  const audit = capability.liveAudit || {};
  console.log(`${name}: ${capability.status}${audit.auditedAt ? ` (audited ${audit.auditedAt})` : ''}`);
  const sections = [
    ['knownMissing', audit.knownMissing],
    ['openQuestions', audit.openQuestions],
    ['notReached', (audit.notReached || []).map((item) => `${item.what} — ${item.why}`)],
    ['boundaries', audit.boundaries],
    ['separateProducts', audit.separateProducts],
    ['resolvedQuestions', audit.resolvedQuestions],
    ['previouslyMissingNowFound', audit.previouslyMissingNowFound],
    ['newlyFound', audit.newlyFound],
  ];
  for (const [label, items] of sections) if (Array.isArray(items) && items.length) {
    console.log(`  ${label}:`);
    for (const item of items) console.log(`    - ${item}`);
  }
  const unobserved = (capability.modules || []).filter((module) => module.observed === false);
  if (unobserved.length) {
    console.log('  notObserved:');
    for (const module of unobserved) console.log(`    - ${module.name}${module.note ? ` — ${module.note}` : ''}`);
  }
  if (audit.verificationNote) console.log(`  note: ${audit.verificationNote}`);
}
async function catalog(argv) {
  const views = argv.filter((item) => item.startsWith('--'));
  for (const view of views) if (!catalogViews.has(view)) fail(usage);
  if (views.length > 1) fail('Pick at most one of --json, --modules, --gaps.');
  const args = argv.filter((item) => !item.startsWith('--'));
  if (args.length > 1) fail(usage);
  const data = JSON.parse(await readFile(catalogFile, 'utf8'));
  const selected = args[0] ? provider(args[0]) : null;
  if (views[0] === '--json') {
    const output = selected ? { schemaVersion: data.schemaVersion, provider: selected, capabilities: data.providers[selected] } : data;
    return console.log(JSON.stringify(output, null, 2));
  }
  const entries = Object.entries(selected ? { [selected]: data.providers[selected] } : data.providers);
  for (const [name, capability] of entries) {
    if (views[0] === '--modules') printModules(name, capability);
    else if (views[0] === '--gaps') printGaps(name, capability);
    else console.log(`${name}: ${capability.status}`);
  }
}
async function audit(selectedProvider, argv) {
  const options = flags(argv, new Set(['--manifest', '--out-dir', '--session', '--resume', '--accept-bounded', '--dry-run']));
  for (const key of ['manifest', 'out-dir']) if (!options[key]) fail(`--${key} is required.`);
  // --session 保留只为向后兼容：它一直要求「固定」，而现在固定是自动的。
  if (options.session) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,62}$/.test(options.session)) fail('--session must contain only letters, numbers, and hyphens.');
    console.error(`[rankup] --session ${options.session} 已忽略：${selectedProvider} 是配额站，`
      + `会话名固定为 ${selectedProvider}-nav，这正是并发度的上限所在。`);
  }
  const entries = validateManifest(JSON.parse(await readFile(options.manifest, 'utf8')), selectedProvider);
  await mkdir(options['out-dir'], { recursive: true });
  const results = [];
  for (const entry of entries) {
    const outDir = path.join(options['out-dir'], entry.id);
    const args = entryArgs(entry, { provider: selectedProvider, outDir, session: options.session, resume: options.resume, acceptBounded: options['accept-bounded'] });
    const result = options['dry-run'] ? { code: 0, dryRun: true } : await child(args);
    results.push({ id: entry.id, outDir, ...result });
  }
  const summary = { provider: selectedProvider, session: options.session, dryRun: Boolean(options['dry-run']), entries: results, failed: results.filter((result) => result.code !== 0).length };
  await writeFile(path.join(options['out-dir'], 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify(summary, null, 2));
  if (summary.failed) process.exitCode = 1;
}
async function main(argv) {
  const [command, ...rest] = argv;
  if (!command || command === '--help' || command === '-h' || command === 'help') return console.log(usage);
  if (command === 'catalog') return catalog(rest);
  if (command === 'audit') return audit(provider(rest.shift()), rest);
  if (command === 'capture' || command === 'run') {
    const selectedProvider = provider(rest.shift());
    const report = rest.shift();
    if (!report || report.startsWith('--') || rest.includes('--self-test')) fail('capture requires a report and cannot run self-test.');
    const result = await child([...rest, '--tool', selectedProvider, '--report', report]);
    if (result.code) process.exitCode = result.code;
    return;
  }
  fail(usage);
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
