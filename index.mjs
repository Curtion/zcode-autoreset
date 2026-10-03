#!/usr/bin/env node
/**
 * zcode-autoreset — 独立的 ZCode / GLM Coding Plan 额度守护服务
 *
 * 做什么：
 *   定时查「5 小时额度」剩余比例；当有任务正在运行、且剩余额度低于阈值时，
 *   自动调用重置接口用掉一张「5 小时额度重置卡」。
 *
 * 两个数据源（均已实测验证）：
 *   额度用量  GET  https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *             auth: Authorization: Bearer <plan api-key>
 *             → limits[] 中 type=TOKENS_LIMIT && unit=3 && number=5，percentage = 已用百分比
 *   重置卡    GET  https://zcode.z.ai/api/v1/coding-plan/reset/status
 *   用重置卡  POST https://zcode.z.ai/api/v1/coding-plan/reset/use
 *             auth: Authorization: Bearer <zcodejwttoken>
 *                 + X-Bigmodel-Authorization: <bigmodel access_token>
 *                 + Bigmodel-Target-Type: PERSONAL
 *
 * 凭证来源：~/.zcode/v2/credentials.json（AES-256-GCM，密钥可本地推导，无需 keychain）
 *
 * 用法：
 *   node index.mjs --dry-run            # 只记录决策，绝不真调 /use（建议先跑这个）
 *   node index.mjs                      # 真跑
 *   node index.mjs --once               # 跑一次就退出
 *   node index.mjs --status             # 打印当前额度与卡，不动作
 */

import { createHash, createDecipheriv } from "node:crypto";
import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------- 配置

const CFG = {
  // 触发阈值：剩余额度低于该百分比时重置（用户要求 3%）
  thresholdPct: num(process.env.AR_THRESHOLD, 3),
  // 主循环间隔（秒）。额度端点是轻量的，30s 很安全；重置端点才有限流
  intervalSec: num(process.env.AR_INTERVAL, 30),
  // 重置端点冷却（秒），windviki 默认 600
  cooldownSec: num(process.env.AR_COOLDOWN, 600),
  // 每日最多用几张卡
  maxPerDay: num(process.env.AR_MAX_PER_DAY, 6),
  // 重置卡列表缓存时长（秒）。/reset/status 有限流，不能每轮都打
  cardRefreshSec: num(process.env.AR_CARD_REFRESH, 600),
  // busy 判定窗口（秒）：tasks-index 内 status=running 且 updated_at 在此窗口内
  activityWindowSec: num(process.env.AR_ACTIVITY_WINDOW, 600),
  // 是否要求“有任务运行中”才重置。默认 true：只在真正干活时才花卡
  requireBusy: bool(process.env.AR_REQUIRE_BUSY, true),
  // 哪种额度：FIVE_HOUR | WEEK
  resetType: (process.env.AR_RESET_TYPE || "FIVE_HOUR").toUpperCase(),
  dataDir: process.env.AR_DATA_DIR || join(import.meta.dirname, "data"),
  zcodeHome: process.env.ZCODE_DATA_BASE_DIR || join(homedir(), ".zcode"),
  dryRun: false,
};

const BASE_ZCODE = "https://zcode.z.ai";
const BASE_BIGMODEL = "https://open.bigmodel.cn";

// ---------------------------------------------------------------- 工具

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : d;
}
function bool(v, d) {
  if (v === undefined) return d;
  return ["1", "true", "yes", "on"].includes(String(v).toLowerCase());
}
function log(...a) {
  // 用本地时间。注意 toISOString() 是 UTC，会比你墙上的钟差 8 小时
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  process.stdout.write(`[${ts}] ${a.join(" ")}\n`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 退出处理
// 前台跑的时候 Ctrl+C 就是正常的停止方式；显式处理一下，免得看起来像“卡住”。
// Windows 上 Ctrl+C 有时不会立刻让 Node 退出，这里强制退。
let stopping = false;
function installSignalHandlers() {
  const stop = (sig) => {
    if (stopping) {
      log(`再次收到 ${sig}，强制退出`);
      process.exit(130);
    }
    stopping = true;
    log(`收到 ${sig} → 正在退出（这是正常停止，不是卡住）`);
    process.exit(0);
  };
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(sig, () => stop(sig));
    } catch {
      // 某些平台不支持个别信号，忽略
    }
  }
  process.on("unhandledRejection", (e) => log("未处理的 Promise 拒绝:", e?.message ?? e));
  process.on("uncaughtException", (e) => log("未捕获异常:", e?.message ?? e));
}

// ---------------------------------------------------------------- 凭证解密

/**
 * ZCode 凭证加密（源码 credential-cipher.ts）：
 *   enc:v1:<b64url(iv,12B)>.<b64url(authTag,16B)>.<b64url(ciphertext)>   aes-256-gcm
 *   key = sha256(secret)
 *   secret = $ZCODE_CREDENTIAL_SECRET ?? `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
 */
function credentialKey() {
  const configured = (process.env.ZCODE_CREDENTIAL_SECRET || "").trim();
  if (configured) return createHash("sha256").update(configured).digest();
  let username = "unknown";
  try {
    username = userInfo().username;
  } catch {}
  const secret = `zcode-credential-fallback:${platform()}:${homedir()}:${username}`;
  return createHash("sha256").update(secret).digest();
}

function decryptValue(value, key) {
  if (!value.startsWith("enc:v1:")) return value;
  const parts = value.slice(7).split(".");
  if (parts.length !== 3) throw new Error("凭证密文格式不合法");
  const [iv, tag, ct] = parts;
  const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

function loadCredentials() {
  const file = join(CFG.zcodeHome, "v2", "credentials.json");
  if (!existsSync(file)) throw new Error(`找不到凭证文件: ${file}`);
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const key = credentialKey();

  const out = {};
  for (const [k, v] of Object.entries(raw)) {
    try {
      out[k] = decryptValue(v, key);
    } catch {
      // 单条解不开不影响其它（可能是别的机器写入或用不同 secret 加密）
      out[k] = null;
    }
  }

  // plan api-key：形如 account-provider:coding-plan:<family>:account:<uid>:api-key
  // 优先个人套餐；team 作为兜底
  const apiKeyEntries = Object.entries(out).filter(
    ([k, v]) => k.startsWith("account-provider:coding-plan:") && k.endsWith(":api-key") && v,
  );
  const pickApiKey =
    apiKeyEntries.find(([k]) => k.includes("individual"))?.[1] ?? apiKeyEntries[0]?.[1] ?? null;

  const jwt = out["zcodejwttoken"] ?? null;
  const access = out["oauth:bigmodel:access_token"] ?? null;

  const missing = [];
  if (!pickApiKey) missing.push("coding-plan api-key");
  if (!jwt) missing.push("zcodejwttoken");
  if (!access) missing.push("oauth:bigmodel:access_token");
  if (missing.length) {
    throw new Error(
      `凭证解密失败或缺失: ${missing.join(", ")}。若你在 ZCode 里重新登录过，请重开一次客户端；` +
        `若设置了 ZCODE_CREDENTIAL_SECRET，服务会优先用它。`,
    );
  }
  return { apiKey: pickApiKey, jwt, accessToken: access };
}

// ---------------------------------------------------------------- HTTP

async function req(url, { method = "GET", headers = {}, body, timeoutMs = 15000 } = {}) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {}
    return { httpStatus: r.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

/** 5 小时额度用量。返回 { usedPct, remainingPct, nextResetTime, level, raw } */
async function fetchQuota(creds) {
  const { httpStatus, json, text } = await req(`${BASE_BIGMODEL}/api/monitor/usage/quota/limit`, {
    headers: { Authorization: `Bearer ${creds.apiKey}` },
  });
  if (httpStatus !== 200 || !json || json.code !== 200) {
    throw new Error(`额度查询失败 HTTP=${httpStatus} code=${json?.code} msg=${json?.msg || text.slice(0, 120)}`);
  }
  const limits = json.data?.limits ?? [];
  // 5 小时窗口 = TOKENS_LIMIT + unit=3（见 bigmodelUsageQuotaMapper 契约）
  const five = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 3);
  const week = limits.find((l) => l.type === "TOKENS_LIMIT" && l.unit === 6);
  const target = CFG.resetType === "WEEK" ? week : five;
  if (!target) {
    throw new Error(
      `未找到 ${CFG.resetType} 额度窗口。当前返回的 limits: ${limits.map((l) => `${l.type}/unit=${l.unit}`).join(", ") || "空"}`,
    );
  }
  return {
    usedPct: Number(target.percentage ?? 0),
    remainingPct: 100 - Number(target.percentage ?? 0),
    nextResetTime: target.nextResetTime ?? null,
    level: json.data?.level ?? null,
    limits,
  };
}

/** 可用重置卡。返回 { fiveHour:[expireAt], week:[expireAt] } */
async function fetchResetStatus(creds) {
  const { httpStatus, json, text } = await req(`${BASE_ZCODE}/api/v1/coding-plan/reset/status`, {
    headers: resetAuth(creds),
  });
  if (httpStatus !== 200 || !json || json.code !== 0) {
    // 3301 = 冷却；429 = 限流
    throw new Error(
      `重置状态查询失败 HTTP=${httpStatus} code=${json?.code} msg=${json?.msg || text.slice(0, 120)}`,
    );
  }
  const d = json.data ?? {};
  const now = Date.now();
  const future = (arr) => (arr ?? []).map((o) => o.expire_at).filter((x) => !x || x > now);
  return { fiveHour: future(d.available_five_hour_resets), week: future(d.available_week_resets) };
}

function resetAuth(creds) {
  return {
    Authorization: `Bearer ${creds.jwt}`,
    "X-Bigmodel-Authorization": creds.accessToken,
    "Bigmodel-Target-Type": "PERSONAL",
  };
}

// ---------------------------------------------------------------- 申领机会（/opportunity）
//
// 官方行为（packages/ui/src/lib/codingPlanQuotaResetCoordinator.ts + useCodingPlanQuotaResetUi.ts）：
//   “/status 只查询已发放机会；**必须再调 /opportunity，否则后端不会执行资格判断**。”
//   “资格仍完全由服务端决定，客户端在非核销/非刚完成时都触发判断。”
//
// 所以：
//   - **客户端不判断闲时/夜间**，也不用自己算时段 —— 一律交给服务端，靠返回的
//     granted / next_try_at 来决定下一次什么时候来试。
//   - 默认冷却 10min；被拒（3301）→ max(nextTryAt, now+5min)；429 与稳定错误退避 10min。
//   - 幂等键：仅瞬时错误（网络/超时/2007）5min 重试并复用同键；服务端已拒绝后必须换新，
//     否则服务端可能按幂等键重放缓存的拒绝（对齐官方 codingPlanQuotaResetCoordinator）。
//   - 手动核销（/use）进行中或刚完成时**不发起**，否则会撞发卡锁导致 429。
//   - 申领与消耗是**两件独立的事**：/use 消耗的是 /status 里已列出的卡，不需要先申领。
const OP_MIN_RETRY_MS = 5 * 60_000;
const OP_DEFAULT_COOLDOWN_MS = 10 * 60_000;
let nextOpportunityAt = 0; // 下次可以去申领的时间
let opportunityKey = null; // 仅瞬时错误重试时复用；服务端拒绝后必须换新
let lastUseFinishedAt = 0; // 上次核销（尝试）结束时间

/** 向服务端申领一次机会（让后端做资格判断）。返回 { note } 供日志展示。 */
async function claimOpportunity(creds) {
  const now = Date.now();
  if (now < nextOpportunityAt)
    return { note: `未到点（还有 ${Math.ceil((nextOpportunityAt - now) / 1000)}s）` };
  if (now - lastUseFinishedAt < OP_DEFAULT_COOLDOWN_MS)
    return { note: "刚核销过，跳过" };

  const key = opportunityKey ?? randomUUID();
  opportunityKey = key;

  let r;
  try {
    r = await req(`${BASE_ZCODE}/api/v1/coding-plan/reset/opportunity`, {
      method: "POST",
      headers: resetAuth(creds),
      body: { idempotency_key: key },
    });
  } catch (e) {
    // fetch 抛错 = 请求可能没到达服务端：保留幂等键, 5min 后带同键重试
    nextOpportunityAt = now + OP_MIN_RETRY_MS;
    return { note: `网络错误(${e?.message ?? e}), ${OP_MIN_RETRY_MS / 60000}min 后带同键重试` };
  }

  if (r.httpStatus === 429) {
    // 官方把 429 归稳定错误：作废旧键, 退避 10min
    opportunityKey = null;
    nextOpportunityAt = now + OP_DEFAULT_COOLDOWN_MS;
    return { note: `HTTP 429 限流, 退避 ${OP_DEFAULT_COOLDOWN_MS / 60000}min` };
  }
  if (r.json?.code === 3301) {
    opportunityKey = null;
    const nt = Number(r.json?.data?.next_try_at) || 0;
    nextOpportunityAt = Math.max(nt, now + OP_MIN_RETRY_MS);
    return { note: `被拒(3301), 下次 ${fmtLocal(nextOpportunityAt)}` };
  }
  if (r.json?.code === 2007) {
    // 官方视 2007 为瞬时错误：保留幂等键, 5min 后带同键重试
    nextOpportunityAt = now + OP_MIN_RETRY_MS;
    return { note: `2007 瞬时错误, ${OP_MIN_RETRY_MS / 60000}min 后带同键重试` };
  }
  if (r.httpStatus !== 200 || r.json?.code !== 0) {
    opportunityKey = null;
    nextOpportunityAt = now + OP_DEFAULT_COOLDOWN_MS;
    return {
      note: `失败 HTTP=${r.httpStatus} code=${r.json?.code}, 退避 ${OP_DEFAULT_COOLDOWN_MS / 60000}min`,
    };
  }

  opportunityKey = null; // 成功，下次换新键
  const granted = Boolean(r.json?.data?.granted);
  nextOpportunityAt = now + OP_DEFAULT_COOLDOWN_MS;
  return { granted, note: granted ? "已发放新机会" : "服务端判定暂不发放" };
}

/**
 * 消耗一张重置卡。只调 /reset/use（带 uuid 幂等键），然后轮询 /status 确认卡数下降。
 * 返回 { ok, confirmed, detail }
 */
async function useReset(creds, type) {
  // 这里刻意【不】调 /reset/opportunity：那是向服务端“申领一个新机会”，
  // 受闲时/发卡锁等条件限制，不在条件内就回 3301（实测每轮都被拒，还白白重试）。
  // 我们要消耗的是 /status 里已列出的 available_*_resets，直接 POST /reset/use。
  const before = (await fetchResetStatus(creds))[type === "WEEK" ? "week" : "fiveHour"].length;
  if (before === 0) return { ok: false, confirmed: false, detail: "没有可用卡" };

  const key2 = randomUUID();
  const use = await req(`${BASE_ZCODE}/api/v1/coding-plan/reset/use`, {
    method: "POST",
    headers: resetAuth(creds),
    body: { idempotency_key: key2, reset_type: type },
  });
  // HTTP 429：请求过快（服务端不带 3301 信封，也没有 next_try_at）
  if (use.httpStatus === 429) {
    return { ok: false, confirmed: false, detail: "HTTP 429 限流" };
  }
  // 业务码 3301：被拒，带 next_try_at 冷却边界 → 退避到那个时间，不要接着重试
  if (use.json?.code === 3301) {
    const nextTryAt = Number(use.json?.data?.next_try_at) || 0;
    return { ok: false, confirmed: false, nextTryAt, detail: `被拒(3301)${nextTryAt ? ` 退避至 ${fmtLocal(nextTryAt)}` : ""}` };
  }
  if (use.httpStatus !== 200 || use.json?.code !== 0) {
    return { ok: false, confirmed: false, detail: `消耗失败 HTTP=${use.httpStatus} code=${use.json?.code} ${use.json?.msg ?? ""}` };
  }

  // 必须确认：轮询 /status 直到机会数下降（否则同池可能被重复消耗）
  for (let i = 0; i < 6; i++) {
    await sleep(1500);
    try {
      const st = await fetchResetStatus(creds);
      const after = st[type === "WEEK" ? "week" : "fiveHour"].length;
      if (after < before) return { ok: true, confirmed: true, detail: `卡数 ${before} → ${after}` };
    } catch {}
  }
  return { ok: true, confirmed: false, detail: "已发出 use，但未在 9s 内确认卡数下降" };
}

// ---------------------------------------------------------------- busy 判定
//
// 信号源有优先级，依次回退：
//   1. cli/db/db.sqlite → session_target.active_run_last_seen_at
//      权威心跳：有 run 在跑时每几秒刷新一次；没在跑则为 NULL。
//   2. cli/rollout/model-io-sess_*.jsonl 的 mtime
//      每个会话一个文件，有模型 I/O 就会追写。
//   3. （已废弃，仅兼容）v2/tasks-index.sqlite 的 task_status='running'
//      注意：这是「协议快照」写入的，会滞后甚至缺失。
//      之前正是用它，导致“明明在跑却报无任务”。

/** 信号源 1：db.sqlite 的 active_run_last_seen_at */
function busyFromRunHeartbeat(sinceMs) {
  const dbPath = join(CFG.zcodeHome, "cli", "db", "db.sqlite");
  if (!existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare(
          "SELECT COUNT(*) AS n FROM session_target WHERE active_run_last_seen_at IS NOT NULL AND active_run_last_seen_at > ?",
        )
        .get(sinceMs);
      return { busy: (row?.n ?? 0) > 0, reason: `活跃run=${row?.n ?? 0}` };
    } finally {
      db.close();
    }
  } catch {
    return null; // 表不存在 / 结构变了 → 回退
  }
}

/** 信号源 2：rollout 里 model-io-*.jsonl 的 mtime */
function busyFromRollout(sinceMs) {
  const dir = join(CFG.zcodeHome, "cli", "rollout");
  if (!existsSync(dir)) return null;
  try {
    let n = 0;
    for (const f of readdirSync(dir)) {
      if (!f.startsWith("model-io-") || !f.endsWith(".jsonl")) continue;
      try {
        if (statSync(join(dir, f)).mtimeMs > sinceMs) n++;
      } catch {}
    }
    return { busy: n > 0, reason: `rollout活跃=${n}` };
  } catch {
    return null;
  }
}

/** 信号源 3（已废弃）：tasks-index 的 task_status='running' */
function busyFromTaskIndex(sinceMs) {
  const dbPath = join(CFG.zcodeHome, "v2", "tasks-index.sqlite");
  if (!existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = require("node:sqlite"));
  } catch {
    return null;
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM tasks WHERE task_status = ? AND updated_at > ?")
        .get("running", sinceMs);
      return { busy: (row?.n ?? 0) > 0, reason: `running=${row?.n ?? 0}(快照,不可靠)` };
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** 有任务正在运行？按优先级依次尝试三个信号源 */
function hasRunningTask() {
  const sinceMs = Date.now() - CFG.activityWindowSec * 1000;
  const sources = [
    ["heartbeat", busyFromRunHeartbeat],
    ["rollout", busyFromRollout],
    ["taskindex", busyFromTaskIndex],
  ];
  const results = [];
  for (const [name, fn] of sources) {
    const r = fn(sinceMs);
    if (r) results.push({ name, ...r });
  }
  if (results.length === 0) {
    return { busy: false, reason: "所有信号源都不可用", source: "none" };
  }
  // 关键：多源取或，而不是“遇到第一个可用的就返回”。
  // heartbeat 读的是 session_target（Goal 模式目标表，普通任务不在里面），会长期 busy=false；
  // 若就此返回，就永远走不到 rollout 这个通用信号（每个会话一个 model-io-*.jsonl）。
  const busyOnes = results.filter((r) => r.busy);
  const detail = results.map((r) => `${r.name}=${r.busy ? "在跑" : "空闲"}(${r.reason})`).join(" ");
  return busyOnes.length
    ? { busy: true, source: busyOnes[0].name, reason: detail }
    : { busy: false, source: results[0].name, reason: detail };
}

// ---------------------------------------------------------------- 状态持久化

const STATE_FILE = () => join(CFG.dataDir, "state.json");
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE(), "utf8"));
  } catch {
    return { lastUseAt: 0, usesByDay: {} };
  }
}
function saveState(s) {
  try {
    mkdirSync(CFG.dataDir, { recursive: true });
    writeFileSync(STATE_FILE(), JSON.stringify(s, null, 2));
  } catch (e) {
    log("状态写入失败:", e.message);
  }
}
const p2 = (n) => String(n).padStart(2, "0");
/** 本地日期 YYYY-MM-DD（日计数用本地自然日，而不是 UTC 日）*/
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
};
/** 本地时间字符串，用于展示到期时间 */
const fmtLocal = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
};

// ---------------------------------------------------------------- 决策 + 主循环

// 重置卡列表缓存：/reset/status 是有限流的接口，不能每 30s 都打
let cardCache = { at: 0, fiveHour: [], week: [] };
// 上游 3301/429 给的退避截止时间；到点前不重试
let blockedUntil = 0;

async function tick(creds, state) {
  const q = await fetchQuota(creds);
  // 只有开了 requireBusy 才去读数据库（否则完全不碰）
  const busy = CFG.requireBusy ? hasRunningTask() : { busy: true, reason: "未检查" };
  const usedToday = state.usesByDay[today()] ?? 0;
  const sinceLast = Date.now() - (state.lastUseAt || 0);

  // 额度没到阈值就不必查卡（用不上）；但要定期刷新一次用于展示
  const nearThreshold = q.remainingPct <= CFG.thresholdPct;
  const neverFetched = cardCache.at === 0;
  const cacheStale = Date.now() - cardCache.at > CFG.cardRefreshSec * 1000;
  let cardsFresh = false;
  if (nearThreshold || neverFetched || cacheStale) {
    try {
      cardCache = { at: Date.now(), ...(await fetchResetStatus(creds)) };
      cardsFresh = true;
    } catch (e) {
      // 真要动作时必须把错误抛出去；否则只是展示，沿用旧缓存
      if (nearThreshold) throw e;
      log(`  （卡列表刷新失败，沿用缓存：${e.message}）`);
    }
  }
  const have = CFG.resetType === "WEEK" ? cardCache.week : cardCache.fiveHour;
  const soonest = have.length ? Math.min(...have) : null;
  const cardAge = cardCache.at ? Math.round((Date.now() - cardCache.at) / 1000) : 0;

  // 申领机会：官方是“每次 /status 刷新之后”发起一次（除非正在核销/刚完成）
  if (cardsFresh && Date.now() >= blockedUntil) {
    try {
      const op = await claimOpportunity(creds);
      if (op.note) log(`  → 申领机会: ${op.note}`);
      if (op.granted) {
        // 服务端刚发了新机会，强制刷新一次卡列表
        cardCache = { at: Date.now(), ...(await fetchResetStatus(creds)) };
        cardsFresh = true;
      }
    } catch (e) {
      log(`  → 申领机会出错（跳过）: ${e.message}`);
    }
  }

  log(
    `额度=${q.level ?? "?"} ${CFG.resetType} 已用 ${q.usedPct}% (剩 ${q.remainingPct}%) | ` +
      (CFG.requireBusy ? `任务 ${busy.busy ? "运行中" : "空闲"}(${busy.reason},源=${busy.source}) | ` : "") +
      `可用卡 ${have.length} 张${cardsFresh ? "" : `(缓存${cardAge}s前)`}${soonest ? ` 最近到期 ${fmtLocal(soonest)}` : ""} | ` +
      `今日已用 ${usedToday}/${CFG.maxPerDay}`,
  );

  const gates = [];
  if (Date.now() < blockedUntil)
    gates.push(`上游退避中 ${Math.ceil((blockedUntil - Date.now()) / 1000)}s`);
  if (q.remainingPct > CFG.thresholdPct) gates.push(`剩余 ${q.remainingPct}% > 阈值 ${CFG.thresholdPct}%`);
  if (CFG.requireBusy && !busy.busy) gates.push("无运行中任务");
  if (have.length === 0) gates.push("无可用卡");
  if (usedToday >= CFG.maxPerDay) gates.push("已达每日上限");
  if (sinceLast < CFG.cooldownSec * 1000)
    gates.push(`冷却中 ${Math.ceil((CFG.cooldownSec * 1000 - sinceLast) / 1000)}s`);

  if (gates.length) {
    log(`  → 不动作：${gates.join("；")}`);
    return;
  }

  log(`  → 命中条件，准备使用一张 ${CFG.resetType} 重置卡`);
  if (CFG.dryRun) {
    log(`  → [DRY-RUN] 跳过真实调用`);
    return;
  }

  const r = await useReset(creds, CFG.resetType);
  lastUseFinishedAt = Date.now();
  log(`  → ${r.ok ? "成功" : "失败"}: ${r.detail}${r.ok && !r.confirmed ? " （未确认，已进入冷却）" : ""}`);

  // 被拒/限流：尊重服务端给的 next_try_at；没给就自己退避一个冷却周期，绝不 30s 硬重试
  if (!r.ok) {
    blockedUntil = r.nextTryAt && r.nextTryAt > Date.now() ? r.nextTryAt : Date.now() + CFG.cooldownSec * 1000;
    log(`  → 将退避至 ${fmtLocal(blockedUntil)}，期间不再尝试`);
  }

  if (r.ok) {
    state.lastUseAt = Date.now();
    state.usesByDay[today()] = usedToday + 1;
    saveState(state);
    try {
      const after = await fetchQuota(creds);
      log(`  → 重置后 ${CFG.resetType} 已用 ${after.usedPct}% (剩 ${after.remainingPct}%)`);
    } catch {}
  }
}

async function main() {
  const args = new Set(process.argv.slice(2));
  CFG.dryRun = args.has("--dry-run");
  const once = args.has("--once") || args.has("--status");
  const statusOnly = args.has("--status");
  if (args.has("--help") || args.has("-h")) {
    process.stdout.write(
      `zcode-autoreset\n\n` +
        `  --dry-run   只记录决策，绝不调用 /use（建议先跑）\n` +
        `  --once      只跑一轮\n` +
        `  --status    只打印额度与卡\n\n` +
        `环境变量: AR_THRESHOLD(3) AR_INTERVAL(30) AR_COOLDOWN(600) AR_MAX_PER_DAY(6)\n` +
        `          AR_RESET_TYPE(FIVE_HOUR|WEEK) AR_REQUIRE_BUSY(1) AR_DATA_DIR\n` +
        `          AR_CARD_REFRESH(600) 卡列表缓存秒数\n` +
        `          AR_REQUIRE_BUSY=0 可关闭“有任务运行中”这个前提\n`,
    );
    return;
  }

  log(`启动 zcode-autoreset${CFG.dryRun ? " [DRY-RUN]" : ""}`);
  installSignalHandlers();
  log(
    `配置: 阈值剩余<${CFG.thresholdPct}% | 间隔 ${CFG.intervalSec}s | 冷却 ${CFG.cooldownSec}s | ` +
      `每日上限 ${CFG.maxPerDay} | 类型 ${CFG.resetType} | busy判定 ${CFG.requireBusy ? "开" : "关"}`,
  );

  const creds = loadCredentials();
  log(`凭证已解密 (api-key ${creds.apiKey.length}B / jwt ${creds.jwt.length}B / token ${creds.accessToken.length}B)`);

  if (statusOnly) {
    const q = await fetchQuota(creds);
    const cards = await fetchResetStatus(creds);
    log(`额度: ${q.level} ${CFG.resetType} 已用 ${q.usedPct}% 剩 ${q.remainingPct}%`);
    log(`卡: 5小时 ${cards.fiveHour.length} 张 / 周 ${cards.week.length} 张`);
    for (const [i, e] of cards.fiveHour.entries())
      log(`  5h#${i + 1} 到期 ${fmtLocal(e)}`);
    return;
  }

  const state = loadState();

  for (;;) {
    try {
      await tick(creds, state);
    } catch (e) {
      log(`本轮出错（已跳过，不重试动作）: ${e.message}`);
    }
    if (once) break;
    await sleep(CFG.intervalSec * 1000);
  }
}

main().catch((e) => {
  log(`致命错误: ${e.message}`);
  process.exitCode = 1;
});