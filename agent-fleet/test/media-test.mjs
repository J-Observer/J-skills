#!/usr/bin/env node
// 用 PATH 中的假 kollab 验证 fleet media 的本地转调，不发送请求。
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createAsserter } from './assert-helper.mjs';

const { assert, finish } = createAsserter('media 命令单测');
const scratch = mkdtempSync(join(tmpdir(), 'fleet-media-test-'));
const actualScratch = realpathSync(scratch);
const stub = join(scratch, 'kollab');
const capture = join(scratch, 'args.json');
writeFileSync(stub, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.writeFileSync(process.env.FLEET_TEST_CAPTURE, JSON.stringify(args));
if (args[0] === 'tool' && args[1] === 'list') {
  console.log(JSON.stringify({ok:true,data:{tools:[
    {name:'generate_image',required:['prompt','model'],properties:{model:{enum:['stub-image']}}},
    {name:'generate_video',required:['prompt','model'],properties:{model:{enum:['stub-video']}}},
    {name:'text_to_speech',required:['text','model'],properties:{model:{enum:['stub-audio']}}},
    {name:'vision',required:['prompt','model'],properties:{model:{enum:['stub-vision']}}}
  ]}}));
} else if (args[0] === 'tool' && args[1] === 'run') {
  if (!process.env.KOLLAB_API_KEY && !process.env.KOLLAB_STANDALONE_API_KEY) {
    console.error(JSON.stringify({ok:false,error:'No credentials available.'})); process.exitCode = 1;
  } else console.log(JSON.stringify({ok:true,data:{local_paths:[require('node:path').join(process.cwd(),'fleet-media','image.png')],status:'succeeded',credits_used:3}}));
} else if (args[0] === 'model' && args[1] === 'list') {
  console.log(JSON.stringify({ok:true,data:{models:[{id:'stub-text',name:'Stub Text'}]}}));
}
`);
chmodSync(stub, 0o755);
const bin = new URL('../bin/agent-fleet.mjs', import.meta.url).pathname;
const env = { ...process.env, PATH: `${scratch}:${process.env.PATH}`, FLEET_TEST_CAPTURE: capture,
  KOLLAB_API_KEY: 'stub-key' };
delete env.KOLLAB_STANDALONE_API_KEY;
function fleet(args, childEnv = env) {
  return spawnSync(process.execPath, [bin, 'media', ...args], { cwd: scratch, env: childEnv, encoding: 'utf8' });
}
try {
  const list = fleet(['list']);
  assert(list.status === 0 && ['image:', 'video:', 'audio:', 'vision:'].every((x) => list.stdout.includes(x)), 'list 按四类打印');
  assert(list.stdout.includes('stub-image') && list.stdout.includes('必填: prompt, model'), 'list 打印模型与必填参数');
  assert(JSON.stringify(JSON.parse(readFileSync(capture, 'utf8'))) === JSON.stringify(['tool', 'list']), 'list 转调 kollab tool list');

  const run = fleet(['run', 'generate_image', '--model', 'gpt-image-2', '--prompt', 'x', '--input-json', '{"size":"1024x1024"}']);
  const args = JSON.parse(readFileSync(capture, 'utf8'));
  assert(run.status === 0 && args.slice(0, 3).join(' ') === 'tool run generate_image', 'run 转调正确工具');
  assert(JSON.stringify(JSON.parse(args[args.indexOf('--input-json') + 1])) === JSON.stringify({ size: '1024x1024', model: 'gpt-image-2', prompt: 'x' }), 'run 合并 model、prompt 与 input-json');
  assert(args.includes('--output-dir') && args[args.indexOf('--output-dir') + 1] === join(actualScratch, 'fleet-media'), 'run 默认输出目录');
  assert(run.stdout.trim() === `${join(actualScratch, 'fleet-media', 'image.png')} | 状态: succeeded | 费用: 3 credits`, 'run 只输出文件路径与摘要');

  const models = fleet(['models', '--source', 'openrouter', '--search', 'stub']);
  assert(models.status === 0 && models.stdout.includes('stub-text') && JSON.parse(readFileSync(capture, 'utf8')).join(' ') === 'model list --source openrouter --search stub', 'models 转调目录及筛选');

  const noKey = { ...env }; delete noKey.KOLLAB_API_KEY;
  const missing = fleet(['run', 'generate_image', '--model', 'gpt-image-2', '--prompt', 'x'], noKey);
  assert(missing.status === 1 && missing.stderr.includes('kollab api-key create') && !missing.stdout.includes('stub-key'), '缺 key 给中文创建提示');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
finish();
