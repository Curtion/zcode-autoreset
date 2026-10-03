> 当前代码完全由AI实现, 已验证在无周额度的旧套餐中可用

# zcode-autoreset

独立的 ZCode / GLM Coding Plan **额度守护服务**：当 **有任务正在运行**、且 **5 小时额度**剩余低于阈值时，自动用掉一张**重置卡**。

零依赖，纯 Node 内置模块（需要 Node ≥ 22.5）。**只有一个入口：`index.mjs`。**

---

## 用法

```bash
node index.mjs --status      # 只看额度与卡（只读，立刻退出）
node index.mjs --dry-run     # 干跑：只记决策，绝不调用 /use（建议先跑一天）
node index.mjs               # 真跑（前台循环，Ctrl+C 停止）
node index.mjs --once        # 只跑一轮
node index.mjs -h            # 帮助
```

`Ctrl+C` 停止前台进程是**预期行为**，会打印 `收到 SIGINT → 正在退出`。

---

## 判定逻辑

四个闸门全部通过才动作：

| 闸门 | 说明 |
|---|---|
| **有任务运行中** | `AR_REQUIRE_BUSY=1`（默认），见下节 |
| **额度** | 剩余低于 `AR_THRESHOLD`（默认 3%） |
| **有卡** | 目标额度类型有可用重置卡 |
| **冷却** | 距上次使用 > `AR_COOLDOWN`（默认 600s） |
| **每日上限** | 今日已用 < `AR_MAX_PER_DAY`（默认 6） |

**用后必须确认**：`/use` 之后轮询 `/status` 直到卡数下降；未确认也进入冷却，避免同池重复消耗。

---

## "有任务运行中"怎么判断（重要）

**不要用 `v2/tasks-index.sqlite` 的 `task_status='running'`** —— 那个字段是**协议快照**写入的，会滞后甚至缺失
（源码注释原话：*"随后到达的 protocol snapshot 可能仍带较旧 running"*）。
实测确认过：正在跑任务时，`tasks-index.sqlite` 里最新记录可以是 6.8 小时前的。

本服务按优先级用三级信号源：

| 优先级 | 信号 | 说明 |
|---|---|---|
| 1 | `cli/db/db.sqlite` → `session_target.active_run_last_seen_at` | **权威心跳**：有 run 在跑时每几秒刷新；没在跑为 `NULL` |
| 2 | `cli/rollout/model-io-sess_*.jsonl` 的 mtime | 每会话一个文件，有模型 I/O 就追写 |
| 3 | `v2/tasks-index.sqlite` 的 `task_status='running'` | 已废弃，仅兼容 |

日志会显示实际用了哪个源，便于排查：

```
任务 运行中(活跃run=1,源=heartbeat)
任务 运行中(rollout活跃=1,源=rollout)
任务 空闲(所有信号源都不可用,源=none)
```

窗口由 `AR_ACTIVITY_WINDOW`（默认 600s）控制。

---

## 数据来源（均已实测验证）

| 用途 | 端点 | 认证 |
|---|---|---|
| **额度用量** | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` | `Authorization: Bearer <plan api-key>` |
| **可用重置卡** | `GET https://zcode.z.ai/api/v1/coding-plan/reset/status` | 双头，见下 |
| **使用重置卡** | `POST https://zcode.z.ai/api/v1/coding-plan/reset/use` | 双头，见下 |

**双头认证**（三条缺一不可）：

```
Authorization:            Bearer <zcodejwttoken>
X-Bigmodel-Authorization: <oauth:bigmodel:access_token>
Bigmodel-Target-Type:     PERSONAL
```

**额度字段契约**（来自 `bigmodelUsageQuotaMapper`）：

| type | unit | 含义 |
|---|---|---|
| `TOKENS_LIMIT` | `3` | **5 小时窗口**（默认目标） |
| `TOKENS_LIMIT` | `6` | 周窗口 |
| `TIME_LIMIT` | `5` | 每月工具调用次数 |

`percentage` = **已使用**百分比（"剩余 < 3%" 等价于 `percentage > 97`）。

**重置接口**：

```
GET  /api/v1/coding-plan/reset/status   → available_five_hour_resets[] / available_week_resets[]（带 expire_at）
POST /api/v1/coding-plan/reset/use      → body: { idempotency_key: <uuid>, reset_type: "FIVE_HOUR" | "WEEK" }
```

> ⚠️ **不要先调 `/reset/opportunity`。** 那个端点是“向服务端**申领一个新机会**”，受闲时 / 发卡锁
> 等条件限制，不在条件内就返回 `3301` + `next_try_at`。而我们要消耗的是 `/status` 里
> **已经列出的卡**，直接 `POST /use` 即可 —— 官方客户端 `useCodingPlanReset` 也只带
> `idempotency_key + reset_type`。
>
> 实测教训：早期版本把 `opportunity` 当头置步骤，结果额度耗尽后**每 30 秒被 3301 拒一次**，
> 而且完全忽略了返回的 `next_try_at`（那是服务端给的退避边界）。现在已改为：
> 直接 `/use`；若仍被 3301/429 拒，则**退避到 `next_try_at`**（没给就退避一个冷却周期），
> 绝不硬重试。

---

## 凭证是怎么拿到的

从 `~/.zcode/v2/credentials.json` 读取并**本地解密**，不需要 keychain / DPAPI / 管理员权限：

```
格式: enc:v1:<b64url(iv,12B)>.<b64url(authTag,16B)>.<b64url(ciphertext)>    // aes-256-gcm
key = sha256(secret)
secret = $ZCODE_CREDENTIAL_SECRET  ??  `zcode-credential-fallback:${platform()}:${homedir()}:${username}`
```

用到的三个 key：

- `account-provider:coding-plan:account:<...individual...>:api-key` → 查额度
- `zcodejwttoken` → 重置接口
- `oauth:bigmodel:access_token` → 重置接口

> 实测这两个 JWT **都没有 `exp` 声明**，正常情况不需要刷新流程。仍要处理 401：**只报错、不重试**。

---

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `AR_REQUIRE_BUSY` | `1` | 要求"有任务运行中"；设 `0` 则只看额度 |
| `AR_THRESHOLD` | `3` | 触发阈值：**剩余**额度低于该百分比时重置 |
| `AR_INTERVAL` | `30` | 主循环间隔（秒） |
| `AR_COOLDOWN` | `600` | 两次重置之间的冷却（秒） |
| `AR_MAX_PER_DAY` | `6` | 每日最多用几张卡 |
| `AR_CARD_REFRESH` | `600` | 卡列表缓存时长（秒），见下节 |
| `AR_RESET_TYPE` | `FIVE_HOUR` | `FIVE_HOUR` 或 `WEEK` |
| `AR_ACTIVITY_WINDOW` | `600` | busy 判定窗口（秒） |
| `AR_DATA_DIR` | `./data` | 状态文件目录（`state.json` 记今日用量） |
| `ZCODE_DATA_BASE_DIR` | `~/.zcode` | ZCode 数据目录（测试时可指向副本） |

bash：`AR_THRESHOLD=5 node index.mjs`
PowerShell：`$env:AR_THRESHOLD=5; node index.mjs`

**日志用本地时间**，"今日已用"的日切也按本地自然日。

---

## 安全设计

- **`--dry-run` 只记录决策，绝不调用 `/use`**
- **用后确认**：轮询 `/status` 直到卡数下降
- **冷却 + 每日上限**双闸门
- **单轮失败只跳过**，不做重试动作
- **信号源失败时显式报错**（`源=none`），不会把故障伪装成"没任务"
- 凭证**不落盘、不打印**
- 退出原因明确打印（Ctrl+C → `收到 SIGINT → 正在退出（这是正常停止，不是卡住）`）

---

## 轮询频率与接口压力

主循环间隔默认 **30 秒**（`AR_INTERVAL`），但**并不是每轮都打所有接口**：

| 接口 | 调用频率 | 说明 |
|---|---|---|
| 额度（`open.bigmodel.cn/.../quota/limit`） | **每轮**（30s） | 轻量端点，很安全 |
| 重置卡（`/reset/status`） | **默认最多 6 次/小时** | 有限流，所以做了缓存 |

卡列表的取数规则：

- **额度没到阈值** → 不必查卡（反正也用不上），只在缓存过期（`AR_CARD_REFRESH`，默认 600s）时刷新一次用于展示
- **额度达到/低于阈值** → **每轮都取新卡**，确保真要动作时用的是最新列表

所以日志里有两种形态：

```
可用卡 4 张            ← 本轮刚查的
可用卡 4 张(缓存5s前)  ← 用的缓存，本轮没打 /status
```

- `/reset/*` 的限流表现：业务码 `3301`（带 `next_try_at` 毫秒冷却边界）和 HTTP `429`
- 把间隔调很小（比如 5s）也不会把 `/status` 打爆：缓存生效时完全不请求

---

## 后台长跑（可选）

`index.mjs` 是前台循环，**关掉终端就会死**。要长期守着，用系统自带方式拉起：

```powershell
# PowerShell：立刻返回，进程继续跑（关掉这个窗口也不影响）
Start-Process -NoNewWindow node -ArgumentList 'index.mjs' -RedirectStandardOutput autoreset.log -RedirectStandardError autoreset.err
```

```bash
# bash / Linux / macOS
nohup node index.mjs > autoreset.log 2>&1 &
```

停止：找到进程后结束即可

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*zcode-autoreset*index.mjs*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId }
```

想开机自启 / 崩溃重启，用 **Windows 计划任务**（触发器=登录时，操作=启动 node，参数=`index.mjs`，起始目录=本目录）。

---

## 测试（不消耗真实的卡）

```bash
# 验证命中路径（阈值调高，dry-run 不会真调用）
AR_THRESHOLD=100 node index.mjs --dry-run --once
# 应看到：→ 命中条件，准备使用一张 FIVE_HOUR 重置卡 → [DRY-RUN] 跳过真实调用

# 验证 busy 判定（造一个假的"活跃 run"环境，不动真实数据）
node make-fake-env.mjs
ZCODE_DATA_BASE_DIR="$PWD/fakez" node index.mjs --dry-run --once
# 应看到：任务 运行中(活跃run=1,源=heartbeat)
```

---

> ⚠️ 本工具会让"额度用完"这件事变成**无声发生**。保留日志并定期看一眼。
> 若关掉 `AR_REQUIRE_BUSY`，额度一跌破阈值就会立刻用卡 —— 哪怕你当时在睡觉，
> 而重置后的 5 小时窗口是从重置那一刻开始计时的。