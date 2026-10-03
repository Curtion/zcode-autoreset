// 测试用：造一个"有活跃 run"的临时环境（不动真实数据）
//
// 造出的是主信号源：cli/db/db.sqlite → session_target.active_run_last_seen_at
//
// 用法：
//   node make-fake-env.mjs
//   ZCODE_DATA_BASE_DIR="$PWD/fakez" AR_REQUIRE_BUSY=1 node index.mjs --dry-run --once
//   预期: 任务 运行中(活跃run=1,源=heartbeat)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const base = path.join(import.meta.dirname, "fakez");
const cliDbDir = path.join(base, "cli", "db");
const v2Dir = path.join(base, "v2");

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(cliDbDir, { recursive: true });
fs.mkdirSync(v2Dir, { recursive: true });

// 1) 主信号源：cli/db/db.sqlite，只建 session_target 表并塞一条"正在跑"的记录
const dbPath = path.join(cliDbDir, "db.sqlite");
const db = new DatabaseSync(dbPath);
db.exec(`
  CREATE TABLE session_target (
    session_id TEXT PRIMARY KEY,
    target_id TEXT,
    objective TEXT,
    status TEXT,
    token_budget INTEGER,
    tokens_used INTEGER,
    time_used_seconds INTEGER,
    time_created INTEGER,
    time_updated INTEGER,
    summary_title TEXT,
    active_input_id TEXT,
    active_run_started_at INTEGER,
    active_run_last_seen_at INTEGER
  );
`);
const now = Date.now();
db.prepare(
  `INSERT INTO session_target
   (session_id, target_id, objective, status, active_run_started_at, active_run_last_seen_at, time_updated)
   VALUES (?,?,?,?,?,?,?)`,
).run("sess_fake_running", "tgt_fake", "fake objective", "active", now - 60_000, now, now);
db.close();
console.log("cli/db/db.sqlite 已建，含 1 条活跃 run");

// 2) 凭证（查额度 / 重置要用）
fs.copyFileSync(
  path.join(os.homedir(), ".zcode", "v2", "credentials.json"),
  path.join(v2Dir, "credentials.json"),
);
console.log("credentials.json 已复制");

console.log("");
console.log("现在执行：");
console.log('  ZCODE_DATA_BASE_DIR="$PWD/fakez" AR_REQUIRE_BUSY=1 node index.mjs --dry-run --once');