# Data model

## 兩個 store

| store | 內容 | 後端 |
|---|---|---|
| tracker store | WorkUnit、Dependency、Comment | sqlite 或 Jira，二選一，不同步 |
| runtime store | Run、engine_state | 永遠是本機 sqlite |

兩邊只靠 `ref`（key）互相指，不做外鍵。Jira 模式下 ticket 全看 Jira，但 Run 沒地方放，所以本機一定有 runtime store。
runtime store 被清掉的話，`blocked` 的 item 當成人工 blocked 處理，不會自動接回。

## Domain 型別

```ts
type Kind = 'item' | 'task'
type Ref = string                       // opaque tracker key, e.g. "PROJ-123"

interface WorkUnit {
  ref: Ref
  kind: Kind
  parent?: Ref                          // task -> item, one level only
  title: string
  body: string                          // markdown
  status: string                        // logical name, validated per kind by config
  assignee?: string                     // nullable from day one
  labels: string[]                      // 'hold' lives here
  origin?: 'refine' | 'splitter' | 'human'   // tasks only
}

interface Dependency { task: Ref; blockedBy: Ref }   // same item only

interface Comment {
  target: Ref
  author: 'human' | 'agent' | 'engine'
  authorName?: string
  kind: 'note' | 'question' | 'system'
  body: string                          // markdown
  createdAt: string
}

interface Run {                         // runtime store only
  id: string
  target: Ref
  rule: string
  agent: string
  attempt: number
  sessionId?: string
  workspace: string
  state: 'running' | 'finished'
  outcome?: Outcome
  leaseUntil: string
  startedAt: string
  finishedAt?: string
  cancelRequestedAt?: string
  cancelMode?: 'soft' | 'hard'
  cancelRequestedBy?: string
  produced: { questions: number; tasks: number }
  usage?: { tokens: number; cost: number }
  logPath: string
}

type Outcome =
  | 'succeeded' | 'needs_input' | 'blocked_manual'
  | 'failed' | 'max_attempts' | 'cancelled' | 'abandoned'
```

## 刻意的設計

- 手動步驟就是預先建好的 manual task。refine 階段（人在互動 session 裡）直接把手動步驟建成 `manual` task，`origin=refine`。Jira 上看得到，人也能直接改，不需要額外欄位。
- 沒有 `mode` 欄位。task 一建出來是 `manual`，它就是手動的。想把 auto task 搶去自己做，把它改成 `manual`。
- task 只有一層，所以不需要遞迴結構。
- Session 沒有獨立的表。續跑時找這個 item 加這個 agent 最近一次有 `sessionId` 的 Run，找不到就開新的。item 與 task 上寫的內容才是記憶，session 只是快取。
- pending 原因分兩半。原因代碼來自最近一次 Run 的 `outcome`，說明文字是 engine 寫的 `system` comment。
- `hold` 是 label，不是 status。
- 狀態對照、規則、agent registry 都在 config，不在資料庫。資料模型只放會變動的東西。
- `produced` 是 use case 在處理 agent 的 MCP 呼叫時累加的計數，engine 驗證 verdict 時用它（見 agent-contract.md）。

## tracker 對照

| 概念 | sqlite | Jira Cloud |
|---|---|---|
| item | `work_unit` 一列 | Issue（type 可設定，例如 Story） |
| task | `work_unit` 一列，帶 `parent` | Sub-task |
| Dependency | `dependency` 表 | issue link（預設 `Blocks`） |
| Comment | `comment` 表 | comment |
| labels | JSON 欄位 | labels |
| assignee | 欄位 | assignee |
| comment 的 author / kind | 欄位 | 待 adapter spec 定（候選：comment property、內容裡的標記） |
| body | markdown | ADF，adapter 負責 markdown 與 ADF 互轉 |

item 與 task 各有自己的 workflow，所以 Jira 的 status mapping 要兩份。
engine 用的 token 是誰，engine 寫的東西就顯示成誰。用專用 bot 帳號或個人 token 都可以，comment 一律帶標記，所以兩種情況都分得出來是人還是 engine 寫的。

## DDL 草稿

sqlite tracker store：

```sql
CREATE TABLE work_unit (
  ref        TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('item','task')),
  parent     TEXT REFERENCES work_unit(ref),
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL,
  assignee   TEXT,
  labels     TEXT NOT NULL DEFAULT '[]',          -- JSON array
  origin     TEXT CHECK (origin IN ('refine','splitter','human')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE dependency (
  task       TEXT NOT NULL REFERENCES work_unit(ref),
  blocked_by TEXT NOT NULL REFERENCES work_unit(ref),
  PRIMARY KEY (task, blocked_by)
);

CREATE TABLE comment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL REFERENCES work_unit(ref),
  author      TEXT NOT NULL CHECK (author IN ('human','agent','engine')),
  author_name TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('note','question','system')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
```

runtime store：

```sql
CREATE TABLE run (
  id                  TEXT PRIMARY KEY,
  target              TEXT NOT NULL,
  rule                TEXT NOT NULL,
  agent               TEXT NOT NULL,
  attempt             INTEGER NOT NULL,
  session_id          TEXT,
  workspace           TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('running','finished')),
  outcome             TEXT CHECK (outcome IN
    ('succeeded','needs_input','blocked_manual','failed','max_attempts','cancelled','abandoned')),
  lease_until         TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  cancel_requested_at TEXT,
  cancel_mode         TEXT CHECK (cancel_mode IN ('soft','hard')),
  cancel_requested_by TEXT,
  produced_questions  INTEGER NOT NULL DEFAULT 0,
  produced_tasks      INTEGER NOT NULL DEFAULT 0,
  tokens              INTEGER,
  cost                REAL,
  log_path            TEXT NOT NULL
);

-- invariant 1: at most one live Run per target
CREATE UNIQUE INDEX one_live_run ON run(target) WHERE state = 'running';
CREATE INDEX run_by_target ON run(target, started_at DESC);

CREATE TABLE engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- e.g. 'paused'
```

## 待定

- `attempt` 的歸零規則。候選是「人每次手動移動 item 的 status 就歸零」。engine 要能觀察到人的移動才做得到，細節待定。
- Jira 上 comment 的 author / kind 標記方式。
