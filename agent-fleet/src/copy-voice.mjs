import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const COPY_VOICE_PATH = fileURLToPath(new URL('../skill/references/copy-voice.md', import.meta.url));

export function prepareCopyPrompt({ friendlyModel, prompt, noVoice = false, copyVoice = false, referencePath = COPY_VOICE_PATH }) {
  if (noVoice || (!copyVoice && !['copy', 'kollab-gateway-copy'].includes(friendlyModel))) return prompt;
  let reference;
  try {
    reference = readFileSync(referencePath, 'utf8');
  } catch {
    throw new Error(`无法读取文案语气规范：${referencePath}。请恢复文件；仅纯机械改写可用 --no-voice。`);
  }
  const block = reference.match(/^## Paste-ready block\r?\n\s*```text\r?\n([\s\S]*?)\r?\n```/m)?.[1];
  if (!block?.trim() || block.split('\n').length > 60) {
    throw new Error(`文案语气规范的 Paste-ready block 缺失、为空或超过 60 行：${referencePath}`);
  }
  return `${block}\n\n${prompt}`;
}
