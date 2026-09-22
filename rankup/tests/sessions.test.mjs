import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const skillRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionsScript = path.join(skillRoot, "scripts", "sessions.mjs");

// 脚本从 HOME 推导 ~/.claude 与 ~/.codex,测试用假 HOME 隔离,不碰真实会话。
function runSessions(home, projectRoot, extra = []) {
  return spawnSync(
    process.execPath,
    [sessionsScript, "--project-root", projectRoot, ...extra],
    { encoding: "utf8", env: { ...process.env, HOME: home, USERPROFILE: home } },
  );
}

async function withHome(run) {
  const base = await mkdtemp(path.join(tmpdir(), "rankup-sessions-test-"));
  try {
    return await run({ base, home: path.join(base, "home") });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

async function writeClaudeSession(home, dirName, fileName, records) {
  const dir = path.join(home, ".claude", "projects", dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, fileName),
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
  );
}

async function writeCodexSession(home, cwd, records) {
  const dir = path.join(home, ".codex", "sessions", "2026", "08", "02");
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "rollout-2026-08-02T10-00-00-test.jsonl"),
    [{ type: "session_meta", payload: { cwd } }, ...records]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
  );
}

const claudeTurn = (cwd, role, text) => ({
  type: role,
  cwd,
  message: { role, content: [{ type: "text", text }] },
});

test("按记录里的 cwd 归属，而不是按目录名反推", async () => {
  await withHome(async ({ home }) => {
    const mine = "/tmp/projects/mine";
    const other = "/tmp/projects/other";
    // 目录名故意与项目路径对不上,证明匹配靠的是 cwd。
    await writeClaudeSession(home, "totally-unrelated-dir-name", "a.jsonl", [
      claudeTurn(mine, "user", "属于本项目"),
    ]);
    await writeClaudeSession(home, "another-dir", "b.jsonl", [
      claudeTurn(other, "user", "属于别的项目"),
    ]);

    const result = runSessions(home, mine);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /a\.jsonl/);
    assert.doesNotMatch(result.stdout, /b\.jsonl/);
  });
});

test("worktree 等子目录的会话算作本项目", async () => {
  await withHome(async ({ home }) => {
    const root = "/tmp/projects/site";
    await writeClaudeSession(home, "wt", "w.jsonl", [
      claudeTurn(path.join(root, ".claude-worktrees", "abc"), "user", "在 worktree 里"),
    ]);
    assert.match(runSessions(home, root).stdout, /w\.jsonl/);
  });
});

test("同时找到 Claude 与 Codex 的会话", async () => {
  await withHome(async ({ home }) => {
    const root = "/tmp/projects/dual";
    await writeClaudeSession(home, "d", "c.jsonl", [claudeTurn(root, "user", "来自 Claude")]);
    await writeCodexSession(home, root, [
      {
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ text: "来自 Codex" }] },
      },
    ]);
    const result = runSessions(home, root);
    assert.match(result.stdout, /claude/);
    assert.match(result.stdout, /codex/);
  });
});

test("dump 只保留自然语言，丢掉工具调用与系统注入", async () => {
  await withHome(async ({ home }) => {
    const root = "/tmp/projects/dump";
    await writeClaudeSession(home, "x", "s.jsonl", [
      claudeTurn(root, "user", "<system-reminder>不该出现的提醒</system-reminder>"),
      claudeTurn(root, "user", "Base directory for this skill: /somewhere\n整段 Skill 正文"),
      claudeTurn(root, "user", "不对，应该按 cwd 判断"),
      {
        type: "assistant",
        cwd: root,
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", name: "Bash", input: { command: "ls" } },
            { type: "text", text: "已确认：按 cwd 判断是对的" },
          ],
        },
      },
    ]);

    const result = runSessions(home, root, ["--dump"]);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /不对，应该按 cwd 判断/);
    assert.match(result.stdout, /已确认：按 cwd 判断是对的/);
    // 工具调用是过程噪音;系统注入与 skill 正文动辄几万字,会一次吃光预算。
    assert.doesNotMatch(result.stdout, /不该出现的提醒/);
    assert.doesNotMatch(result.stdout, /整段 Skill 正文/);
    assert.doesNotMatch(result.stdout, /tool_use/);
  });
});

test("窗口之外的会话不计入", async () => {
  await withHome(async ({ home }) => {
    const root = "/tmp/projects/window";
    await writeClaudeSession(home, "y", "recent.jsonl", [claudeTurn(root, "user", "刚刚")]);
    const result = runSessions(home, root, ["--days", "1"]);
    assert.match(result.stdout, /recent\.jsonl/);
  });
});

test("没有匹配会话时给出明确说明而不是空输出", async () => {
  await withHome(async ({ home }) => {
    const result = runSessions(home, "/tmp/projects/empty");
    assert.equal(result.status, 0);
    assert.match(result.stdout, /没有属于/);
  });
});

test("水位线让下一次 review 不重读已消费的内容", async () => {
  await withHome(async ({ base, home }) => {
    const root = path.join(base, "proj");
    await mkdir(root, { recursive: true });
    const dir = path.join(home, ".claude", "projects", "p");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "s.jsonl");
    const line = (role, text) => JSON.stringify(claudeTurn(root, role, text)) + "\n";

    await writeFile(file, line("user", "第一轮的纠正"));
    assert.match(runSessions(home, root, ["--new-only", "--dump"]).stdout, /第一轮的纠正/);

    // 落水位:review 真正消费完之后才记,所以 --mark 是独立一步。
    runSessions(home, root, ["--mark"]);
    assert.match(runSessions(home, root, ["--new-only", "--dump"]).stdout, /没有新增会话/);

    // 同一个会话续聊后,只读新增的那一段,不重复消耗上下文。
    await appendFile(file, line("user", "第二轮的纠正"));
    const resumed = runSessions(home, root, ["--new-only", "--dump"]).stdout;
    assert.match(resumed, /第二轮的纠正/);
    assert.doesNotMatch(resumed, /第一轮的纠正/);
  });
});

test("会话被清理重建导致水位线超出文件长度时从头读", async () => {
  await withHome(async ({ base, home }) => {
    const root = path.join(base, "proj2");
    await mkdir(path.join(root, ".rankup"), { recursive: true });
    const dir = path.join(home, ".claude", "projects", "q");
    await mkdir(dir, { recursive: true });
    const file = path.join(dir, "s.jsonl");
    await writeFile(file, JSON.stringify(claudeTurn(root, "user", "短内容")) + "\n");
    // 伪造一个远大于当前文件的水位,模拟会话被清空重建。
    await writeFile(
      path.join(root, ".rankup", "review-state.json"),
      JSON.stringify({ schemaVersion: 1, sessions: { [file]: { bytes: 999_999 } } }),
    );
    assert.match(runSessions(home, root, ["--new-only", "--dump"]).stdout, /短内容/);
  });
});

test("非法 --days 直接报错", async () => {
  await withHome(async ({ home }) => {
    const result = runSessions(home, "/tmp/x", ["--days", "-3"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /--days/);
  });
});
