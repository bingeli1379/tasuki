# Config and rules

狀態：草稿。欄位與預設值還沒逐項確認。

使用者只需要改這一份檔案，就能換 tracker、對應 status、換 agent、改規則。格式用 JSONC（JSON 加註解），再提供 `$schema` 讓編輯器自動補全。
熱重載：新的 Run 用新 config，執行中的 Run 沿用啟動時的快照。新 config 驗證失敗就保留舊的，並在 API 與 log 上回報。
`${VAR}` 會展開成環境變數，找不到就報錯。config 裡不放明文 token。

## 形狀

`tracker` 與 `agents` 裡的 `kind` 會改成指定 plugin，實際形狀等 plugins.md 定案後再改這裡。

```jsonc
{
  "$schema": "./tasuki.config.schema.json",
  "version": 1,
  "dataDir": "./data",                         // relative to the folder this file lives in

  "tracker": {
    "kind": "sqlite",                          // "sqlite" | "jira-cloud"
    "jira": {
      "baseUrl": "https://example.atlassian.net",
      "email": "${JIRA_EMAIL}",
      "apiToken": "${JIRA_API_TOKEN}",
      "project": "PROJ",
      "issueTypes": { "item": "Story", "task": "Sub-task" },
      "dependencyLinkType": "Blocks"
    }
  },

  // logical name -> actual name in the tracker
  "statuses": {
    "item": {
      "refining": "Refining",
      "ready-to-split": "Ready to Split",
      "splitting": "Splitting",
      "needs-answers": "Needs Answers",
      "split-review": "Split Review",
      "in-progress": "In Progress",
      "in-review": "In Review",
      "ready-to-rework": "Ready to Rework",
      "blocked": "Blocked",
      "done": "Done"
    },
    "task": {
      "to-do": "To Do",
      "in-progress": "In Progress",
      "in-review": "In Review",
      "manual": "Manual",
      "done": "Done"
    }
  },

  "labels": { "hold": "hold" },

  "poll": { "intervalSeconds": 5 },            // default: 5 for sqlite, 30 for jira-cloud

  "limits": {
    "maxConcurrentRuns": 2,
    "leaseSeconds": 120,
    "softGraceSeconds": 300,
    "hardGraceSeconds": 10,
    "runTimeoutMinutes": 60,
    "idleTimeoutMinutes": null,                // null = off
    "defaultMaxAttempts": 3
  },

  "workspace": { "cleanup": "never" },         // "never" | "on-done"; root defaults to <dataDir>/workspaces

  "agents": {
    "claude-main": {
      "kind": "claude-cli",
      "auth": "inherit-login",                 // "api-key" | "inherit-login" | "oauth-token"
      "model": null,
      "allowedTools": [],
      "env": { "GITLAB_TOKEN": "${GITLAB_TOKEN}" },   // passed to the spawned CLI only
      "requires": { "mcpServers": [], "skills": [] }   // optional preflight, see doctor
    },
    "codex-main": { "kind": "codex-cli", "auth": "inherit-login", "env": {} }
  },

  "rules": [ /* see Default rules */ ],

  "server": { "host": "127.0.0.1", "port": 8787, "allowInsecure": false },

  "auth": {
    "kind": "none",                            // "none" | "static" | "http"
    "session": { "ttl": "24h" }                // duration or "never"
  }
}
```

`env` 是給被 spawn 的 agent CLI 用的，engine 自己不使用裡面的值。engine 不碰 git，所以不放 GitHub / GitLab 的設定。

`allowedTools` 是 CLI 自己的工具名稱清單。空陣列或省略，代表除了 runner 注入的 tasuki MCP tool 之外一律不准，因為 headless 沒有人能即時按允許。名稱格式依 CLI 而定，待驗證。`init` 產生的 config 要帶一份能完成 split / execute 的預設清單，等 M3 驗證完再填。

`auth` 只宣告認證方式，憑證本身一律放 `env`，不另外開欄位。`inherit-login` 沿用 CLI 自己的登入，不需要任何變數。`api-key` 與 `oauth-token` 要求 `env` 裡有對應的變數，變數名稱依 CLI 而定，待驗證。省略時是 `inherit-login`。

## 路徑

- config 檔一定要有。用 `--config <path>` 指定，沒給就找工作目錄的 `tasuki.config.jsonc`，找不到就報錯並提示跑 `tasuki init`，不悄悄退回別的地方。
- config 裡所有相對路徑都相對於 config 檔所在的資料夾，不是 process 的工作目錄。
- `dataDir` 預設 `./data`。tracker 是 sqlite 時，檔案固定在 `<dataDir>/tracker.db`。runtime store 在 `<dataDir>/runtime.db`，Run log 在 `<dataDir>/logs/`，`workspace.root` 沒設時是 `<dataDir>/workspaces`。
- 啟動時印出解析後的絕對路徑。

一個 instance 就是一個資料夾，裡面有 config，第一次啟動時旁邊長出 `data/`，要備份或搬家整包帶走：

```
my-instance/
  tasuki.config.jsonc      你寫的
  data/                    第一次啟動時建立，不進 git
    tracker.db             tracker 是 sqlite 時才有
    runtime.db             Run 與 lease，永遠有
    logs/
    workspaces/            每張 item 一個工作目錄
```

資料夾放哪裡都可以，用 `tasuki start --config <路徑>` 指定，或先 `cd` 進去直接 `tasuki start`。container 裡把 `dataDir` 設成 `/data` 再掛 volume。

範例見根目錄的 `tasuki.config.example.jsonc`，複製成 `tasuki.config.jsonc` 來改。現在還沒有任何程式讀它，server 仍吃環境變數 `TASUKI_DATA_DIR`、`TASUKI_PORT`，S1 才會接上。`tracker`、`agents`、`rules` 的形狀還沒定，範例裡先不寫。

## Rule 欄位

| 欄位 | 意思 |
|---|---|
| `id` | 規則名稱，Run 與 log 會引用 |
| `watch` | 監看的 item status 邏輯名。規則只作用在 item，所以沒有 `kind` 欄位 |
| `claim` | 認領後 item 暫停的 status，可省略。省略時只靠 lease 防重複 |
| `agent` | 用哪個 agent（agents 裡的 key） |
| `mode` | `split` / `execute` / `rework`，以 `TASUKI_MODE` 傳給 agent |
| `prompt` / `promptFile` | 給 agent 的指令範本，省略時用引擎內建、對應 `mode` 的預設 prompt。兩個不能同時設 |
| `session` | `fresh` 或 `per-item`（續用這個 item 在同一個 agent 上最近的 session） |
| `timeoutMinutes` | 覆寫 `limits.runTimeoutMinutes` |
| `maxAttempts` | 覆寫 `limits.defaultMaxAttempts` |
| `on` | outcome 對應到的 status 邏輯名 |

MCP 的權限角色不是規則欄位，由 `mode` 決定：`split` 與 `rework` 是 splitter，`execute` 是 orchestrator（見 agent-contract.md）。

`on` 可以設的 key 是 `succeeded`、`needs_input`、`blocked_manual`、`failed`、`max_attempts`。`failed` 與 `max_attempts` 省略時都是 `blocked`。`cancelled` 不會移動 status，`abandoned` 由復原機制處理，兩者都不用設。

prompt 範本可用的變數：`{{item.ref}}`、`{{run.id}}`、`{{workspace}}`、`{{mode}}`。ticket 的內容（包含標題）不塞進 prompt，因為那是使用者寫的，可能夾帶指令。agent 用 MCP 的讀取 tool 自己拿，這樣 sqlite 和 Jira 模式也用同一份 prompt。

## Default rules

```jsonc
[
  {
    "id": "split",
    "watch": "ready-to-split",
    "claim": "splitting",
    "agent": "claude-main",
    "mode": "split",
    "session": "per-item",
    "on": {
      "succeeded": "split-review",
      "needs_input": "needs-answers",
      "failed": "blocked",
      "max_attempts": "blocked"
    }
  },
  {
    "id": "execute",
    "watch": "in-progress",
    // no claim status: dedupe by lease
    "agent": "claude-main",
    "mode": "execute",
    "timeoutMinutes": 480,
    "session": "per-item",
    "on": {
      "succeeded": "in-review",
      "needs_input": "blocked",
      "blocked_manual": "blocked",
      "failed": "blocked",
      "max_attempts": "blocked"
    }
  },
  {
    "id": "rework",
    "watch": "ready-to-rework",
    "claim": "splitting",
    "agent": "claude-main",
    "mode": "rework",
    "session": "per-item",
    "on": {
      "succeeded": "split-review",
      "needs_input": "blocked",
      "failed": "blocked",
      "max_attempts": "blocked"
    }
  }
]
```

`rework` 的 `needs_input` 去 `blocked` 而不是 `needs-answers`，原因見 D31。

不要 split-review 這個關卡的人，把 `split` 與 `rework` 的 `succeeded` 改成 `in-progress`。
想讓 AI 先審一輪再給人，另外加一條 `watch: "in-review"` 的規則即可，不用改程式。

## 驗證（`doctor`）

啟動時與 `doctor` 指令都跑同一組檢查，錯誤要指出是哪條規則、哪個欄位。

1. 規則用到的每個 status 都存在於 `statuses.item`。
2. 不同規則的 `watch` 不重複。兩條規則監看同一個 status 會產生歧義。
3. `claim` 不等於 `watch`（可省略）。
4. `on` 的每個目標都存在，而且規則可能產生的每個 outcome 都有目標。`failed` 與 `max_attempts` 有預設，`blocked_manual` 對 split / rework 不會發生，這三個可省略。
5. 規則引用的 agent 存在。
6. `${VAR}` 都能展開。
7. `server.host` 非 loopback 又沒有 auth 又沒設 `allowInsecure` 就拒絕啟動（見 security-and-auth.md）。
8. Jira：mapping 的每個 status 都存在於 project 的 workflow，規則用到的每一個轉移（from 到 to）在 workflow 裡目前都允許。逐條列出不合法的轉移。
9. agent preflight：CLI 在 PATH 上。`requires` 列出的 MCP server 與 skill 有裝。偵測方式依 CLI 而定，待驗證。
10. agent 的 `auth` 不是 `inherit-login` 時，`env` 裡有對應的變數而且展開後不是空字串。`allowedTools` 是空的就警告，因為這個 agent 只能呼叫 tasuki 的 MCP tool，沒辦法改檔。
11. 同一條規則的 `prompt` 與 `promptFile` 不能同時設定，`promptFile` 指到的檔案要存在。
