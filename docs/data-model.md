# Data model

## 兩個 store

| store | 內容 | 後端 |
|---|---|---|
| tracker | WorkUnit、Dependency、Comment、Attachment | sqlite 或 Jira，二選一，不同步 |
| store | Run、engine_state、帳號與 session、流程設定的每一版、共用 key 時 item 在哪站（D104） | 預設 sqlite，可換成別的 store plugin（D88） |

兩邊只靠 `ref`（key）互相指，不做外鍵。Jira 模式下 ticket 全看 Jira，但 Run 沒地方放，所以一定有 store。
store 被清掉的話，`blocked` 的 item 當成人工 blocked 處理，不會自動接回；共用 key 的站上的 item 都回到那組的第一站（D104）。

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
  version: string                       // opaque; changes with title, body or status (D61)
}

interface Dependency { task: Ref; blockedBy: Ref }   // same item only

interface Comment {
  id: string
  target: Ref
  author: 'human' | 'agent' | 'engine'
  authorName?: string
  kind: 'note' | 'question' | 'system'
  body: string                          // markdown
  createdAt: string
}

interface Attachment {                  // D61
  id: string
  target: Ref
  filename: string
  mimeType: string
  size: number                          // bytes, at most 10 MB
  createdAt: string
}

interface Run {                         // store only
  id: string
  target: Ref                           // the item, or the task a dispatch rule runs
  item: Ref                             // the item it works for: target itself, or the task's item (D102)
  rule: string
  agent: string
  attempt: number
  sessionId?: string
  workspace: string
  state: 'running' | 'finished'
  outcome?: Outcome
  verdict?: Verdict                     // what report_result said; outcome is decided at exit (D63)
  summary?: string
  leaseUntil: string
  startedAt: string
  lastActivityAt: string
  finishedAt?: string
  cancelRequestedAt?: string
  cancelMode?: 'soft' | 'hard'
  cancelRequestedBy?: string
  produced: { questions: number; tasks: number }
  usage?: { tokens: number; cost: number }
}

type Outcome =
  | 'succeeded' | 'needs_input' | 'blocked_manual'
  | 'failed' | 'max_attempts' | 'cancelled' | 'abandoned'
```

## 刻意的設計

- body 與 comment 都是 markdown，單一換行就是換行（跟 GitHub issue、Jira 一樣，不是 CommonMark 的併成一行）。markdown 表達不了的 tracker 內容（Jira 的 mention、表格、panel）寫成 embed token `[[embed:<標籤>|<內容>]]`，裡面帶著原本的節點，存回去時原樣放回；刪掉 token 就是刪掉那段內容。底線、文字顏色、上下標、對齊沒有對應的 markdown，存回 Jira 時會掉，字留著（D61）。
- body 用 `![說明](attachment:<id>)` 引用同一張 item 的附件，各 tracker 自己換成它的嵌入方式。

- 手動步驟就是預先建好的 manual task。refine 階段（人在互動 session 裡）直接把手動步驟建成 `manual` task，`origin=refine`。Jira 上看得到，人也能直接改，不需要額外欄位。
- 沒有 `mode` 欄位。task 一建出來是 `manual`，它就是手動的。想把 auto task 搶去自己做，把它改成 `manual`。
- task 只有一層，所以不需要遞迴結構。
- Session 沒有獨立的表。續跑時找這個 item 加這個 agent 最近一次有 `sessionId` 的 Run，找不到就開新的。item 與 task 上寫的內容才是記憶，session 只是快取。
- pending 原因分兩半。原因代碼來自最近一次 Run 的 `outcome`，說明文字是 engine 寫的 `system` comment。
- `hold` 是 label，不是 status。
- 狀態對照、規則、agent registry 都在 config，不在資料庫。資料模型只放會變動的東西。
- `produced` 是 use case 在處理 agent 的 MCP 呼叫時累加的計數，engine 驗證 verdict 時用它（見 agent-contract.md）。
- `lastActivityAt` 是 agent 最後一次有動靜的時間，建立 Run 時等於 `startedAt`。CLI 有輸出或 agent 呼叫 MCP tool 都算動靜。engine 在記憶體裡記最新值，隨每次 `renewLease` 一起寫入，不是每次動靜都寫。用途是 UI 顯示與 `idleTimeoutMinutes`（見 stop-and-recovery.md）。

## tracker 對照

| 概念 | sqlite | Jira Cloud |
|---|---|---|
| item | `work_unit` 一列 | Issue（type 可設定，例如 Story） |
| task | `work_unit` 一列，帶 `parent` | Sub-task |
| Dependency | `dependency` 表 | issue link（type 可設定，例如 Blocks，config 寫 id）。從被擋住的 task 看，`inwardIssue` 是擋住它的那張 |
| task 的 origin | 欄位 | issue property `tasuki`（`{ origin }`），建 task 時一起寫。沒有 property 的 sub-task 是人在 Jira 上建的，當成 `human`（D65） |
| Comment | `comment` 表 | comment |
| labels | JSON 欄位 | labels |
| assignee | 欄位 | assignee |
| comment 的 author / kind | 欄位 | agent 與 engine 的 comment 帶 comment property `tasuki`（`{ author, kind }`），內文第一行是看得見的「tasuki · agent」之類的標記；人按按鈕留的 `system` 紀錄也帶 property，但沒有標記（D74）；登入的人寫的 comment 帶 property，`name` 是他的顯示名（D89）；沒有 property 的是人寫的 note（D61） |
| body | markdown | ADF，adapter 負責 markdown 與 ADF 互轉（D61） |
| Attachment | `attachment` 表，內容是 BLOB | issue 的附件 |
| body 裡的圖 | `![x](attachment:<id>)` 原樣存 | ADF 的 media 節點，用附件的 media id（D61） |
| version | 欄位，每次改 title、body、status 加一 | title、description、status 的 hash |
| ref | `<refPrefix>-<n>`，前綴在 plugin 的 `options.refPrefix`，預設 `TSK`；n 是 `ref_counter` 發的流水號，刪掉的 task 的號碼不會再發（D52、D70） | issue key |
| 刪 task | 同一個 transaction 刪掉它的 dependency（兩個方向）、comment、附件與它自己 | `DELETE /issue/{key}`，Jira 連 link、comment、附件一起刪 |
| status 存什麼 | 流程設定對照的 tracker key（預設是邏輯名，改顯示名不動資料，D91） | status id（D50） |
| 共用 key 的站 | 兩邊一樣：tracker 存那組的 key，item 不在第一站時，store 的 `item_status` 記它在哪站（D104） | 同左 |

item 與 task 各有自己的 workflow，所以 Jira 的 status mapping 要兩份。
engine 用的 token 是誰，engine 寫的東西就顯示成誰。用專用 bot 帳號或個人 token 都可以，comment 一律帶標記，所以兩種情況都分得出來是人還是 engine 寫的。

## DDL 草稿

實作時每個切片用到哪張表，才把那張表的 DDL 寫成一支 migration（見 D42），不一次建完。

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

-- S3 added: version INTEGER NOT NULL DEFAULT 1 on work_unit

CREATE TABLE comment (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  target      TEXT NOT NULL REFERENCES work_unit(ref),
  author      TEXT NOT NULL CHECK (author IN ('human','agent','engine')),
  author_name TEXT,
  kind        TEXT NOT NULL CHECK (kind IN ('note','question','system')),
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX comment_by_target ON comment(target, id);

CREATE TABLE attachment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  target     TEXT NOT NULL REFERENCES work_unit(ref),
  filename   TEXT NOT NULL,
  mime_type  TEXT NOT NULL,
  size       INTEGER NOT NULL,
  data       BLOB NOT NULL,                       -- in the db: one file to back up
  created_at TEXT NOT NULL
);
CREATE INDEX attachment_by_target ON attachment(target, id);

-- S7: the last number handed out. MAX(rowid) + 1 gave a deleted last row's ref out again.
CREATE TABLE ref_counter (last INTEGER NOT NULL);
```

store（S4 建了 `run` 表、只建了用到的欄位，S5 加了 `produced_questions`、`produced_tasks`，S7c 加了 cancel 的三欄，S7d 建了 `engine_state` 並重建 `run` 讓 `cancel_requested_by` 多收 `pause`，S8 加了 `session_id`，D82 加了 `from_status`、`to_status`，W3 拿掉 `log_path`（log 由 engine 命名，D88），S13 加了 `item`（D102），W5 建了 `item_status`（D104），見 `packages/sqlite/src/store-migrations.ts`；usage 的欄位等用到的切片再加）：

```sql
CREATE TABLE run (
  id                  TEXT PRIMARY KEY,
  target              TEXT NOT NULL,
  item                TEXT NOT NULL,  -- target, or the item of a dispatched task (D102)
  rule                TEXT NOT NULL,
  agent               TEXT NOT NULL,
  attempt             INTEGER NOT NULL,
  from_status         TEXT,  -- the status the item was claimed from (D82)
  to_status           TEXT,  -- where the engine moved it at the end; unset when it moved nothing
  session_id          TEXT,
  workspace           TEXT NOT NULL,
  state               TEXT NOT NULL CHECK (state IN ('running','finished')),
  outcome             TEXT,  -- a rule names its own outcomes, so config checks them, not a CHECK (D84)
  verdict             TEXT,
  summary             TEXT,
  lease_until         TEXT NOT NULL,
  started_at          TEXT NOT NULL,
  last_activity_at    TEXT NOT NULL,
  finished_at         TEXT,
  cancel_requested_at TEXT,
  cancel_mode         TEXT CHECK (cancel_mode IN ('soft','hard')),
  cancel_requested_by TEXT CHECK (cancel_requested_by IN ('stop','hold','moved','pause')),
  produced_questions  INTEGER NOT NULL DEFAULT 0,
  produced_tasks      INTEGER NOT NULL DEFAULT 0,
  tokens              INTEGER,
  cost                REAL
);

-- invariant 1: at most one live Run per target
CREATE UNIQUE INDEX one_live_run ON run(target) WHERE state = 'running';
CREATE INDEX run_by_target ON run(target, started_at DESC);

CREATE TABLE engine_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- e.g. 'paused'

-- S9 (D89): who may do what. Identity comes from the auth plugin, access lives here.
CREATE TABLE account (
  user_id       TEXT PRIMARY KEY,               -- from the auth plugin
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  access        TEXT NOT NULL CHECK (access IN ('admin','maintainer','member')),
  password_hash TEXT,                           -- builtin only; scrypt
  disabled_at   TEXT,
  created_at    TEXT NOT NULL,
  external_id   TEXT UNIQUE                     -- auth-http: the outside userId, bound at the first sign in (D90)
);

CREATE TABLE session (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES account(user_id),
  ttl        TEXT NOT NULL,                     -- the ttl it was issued under; a changed ttl ends it
  expires_at TEXT,                              -- unset when ttl is 'never'
  created_at TEXT NOT NULL
);

CREATE TABLE api_token (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES account(user_id),
  name       TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  created_at TEXT NOT NULL
);

-- W4a (D91), W6a (D105): every save of a settings document, the flow or the instance's. The
-- store keeps the JSON as given; the engine checks it. The newest version of each is the one
-- in use; none yet means the built-in default.
CREATE TABLE settings_version (
  doc      TEXT NOT NULL,                       -- 'flow' | 'instance' | 'tracker' | 'agents'
  version  INTEGER NOT NULL,                    -- 1, 2, ... per doc; a save names the one it started from
  value    TEXT NOT NULL,                       -- JSON: workflow, rules, labels | poll, limits | plugin, options (secrets sealed)
  saved_by TEXT NOT NULL,                       -- the saver's display name, copied; '' with no sign-in
  saved_at TEXT NOT NULL,
  PRIMARY KEY (doc, version)
);

-- W5 (D104): which station an item is in when its tracker status is shared by several.
-- No row means the first of them; the tracker holds only the shared key.
CREATE TABLE item_status (
  ref    TEXT PRIMARY KEY,
  status TEXT NOT NULL                          -- logical name
);
```

## attempt

只有前一次 Run 是 `abandoned` 才加 1，其他結果之後都從 1 重算，`max_attempts` 也記成一筆 Run，所以人把 item 從 `blocked` 拉回來就是從 1 開始（D38）。engine 不觀察人的移動。
