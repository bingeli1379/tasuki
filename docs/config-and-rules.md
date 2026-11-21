# Config and rules

狀態：草稿。欄位與預設值還沒逐項確認。

使用者只需要改這一份檔案，就能換 tracker、對應 status、換 agent、改規則。格式用 JSONC（JSON 加註解），再提供 `$schema` 讓編輯器自動補全。
熱重載：新的 Run 用新 config，執行中的 Run 沿用啟動時的快照。新 config 驗證失敗就保留舊的，並在 API 與 log 上回報。
`${VAR}` 會展開成環境變數，找不到就報錯。config 裡不放明文 token，所以 config 可以進 git。
config 檔旁邊有 `.env` 的話，啟動時先讀進環境變數（Node 內建的 `process.loadEnvFile`），已經存在的環境變數不被覆蓋。`.env` 不進 git（D49）。

## 形狀

`tracker` 用 `plugin` 加 `options` 指定（D48，見 plugins.md）。省略 `tracker` 時是 `@tasuki/sqlite`（D1）。`agents` 的每一個 agent 也是 `plugin` 加 `options`，指定一個 runner plugin（D63）。

```jsonc
{
  "$schema": "./tasuki.config.schema.json",
  "version": 1,
  "dataDir": "./data",                         // relative to the folder this file lives in

  // sqlite: { "plugin": "@tasuki/sqlite", "options": { "refPrefix": "TSK" } }   // refs become TSK-1, TSK-2...
  "tracker": {
    "plugin": "@tasuki/jira-cloud",
    "options": {                               // handed to the plugin as-is, after ${VAR} expansion
      "baseUrl": "https://example.atlassian.net",
      "email": "${JIRA_EMAIL}",
      "apiToken": "${JIRA_API_TOKEN}",
      "project": "PROJ",
      "issueTypes": { "item": "10009", "task": "10007" },   // ids, see D50
      "dependencyLinkType": "10000"            // issue link type id, see D50
    }
  },

  // The item statuses in board order, the roles code uses them for, and the task statuses'
  // tracker keys (D81). key is the tracker's status: the name for sqlite, the status id for
  // Jira (D50). Omitted, key is name, and name is the id in Title Case. Omit the whole
  // workflow for the default below (sqlite only, since its keys are the names).
  "workflow": {
    "statuses": [
      { "id": "refining", "key": "10003" },
      { "id": "ready-to-split", "name": "Ready to Split", "key": "10006" },
      { "id": "needs-answers", "key": "10008", "handledBy": "person" },
      { "id": "split-review", "key": "10009", "handledBy": "person",
        "outcomes": { "→ Refining": "refining", "→ In Progress": "in-progress" } },
      { "id": "in-progress", "key": "3" },
      { "id": "in-review", "key": "10004", "handledBy": "person",
        "outcomes": { "→ Ready to Rework": "ready-to-rework", "→ Done": "done" } },
      { "id": "ready-to-rework", "name": "Ready to Rework", "key": "10010" },
      { "id": "blocked", "key": "10011", "handledBy": "person" },
      { "id": "done", "key": "10005" }
    ],
    "roles": {
      "entry": "refining", "done": "done", "failure": "blocked",
      "taskReview": "split-review", "rework": "ready-to-rework"
    },
    "taskStatuses": {
      "to-do": "10003", "in-progress": "3", "in-review": "10004", "manual": "10012", "done": "10005"
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

  // A runner plugin each; the fields inside options are that plugin's own.
  "agents": {
    "claude-main": {
      "plugin": "@tasuki/claude-cli",
      "options": {
        "auth": "inherit-login",               // only inherit-login so far; "api-key" | "oauth-token" later
        "model": null,                         // null: the CLI's own default
        "allowedTools": ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git:*)"],   // on top of the tasuki tools
        "env": { "GITLAB_TOKEN": "${GITLAB_TOKEN}" },   // passed to the spawned CLI only
        "inheritSettings": false,              // true: load this machine's Claude settings, CLAUDE.md, hooks, plugins, MCP servers
        "plugins": ["${HOME}/plugins/sdd"],   // plugin folders loaded even when isolated
        "mcpServers": {},                      // more MCP servers; allow their tools as "mcp__<name>"
        "appendSystemPromptFile": "agents/base.md",   // or appendSystemPrompt: the agent's standing instructions
        "requires": { "mcpServers": [], "skills": [] }   // optional preflight, see doctor (S10)
      }
    },
    "codex-main": { "plugin": "@tasuki/codex-cli", "options": { "auth": "inherit-login" } },
    "fake": { "plugin": "@tasuki/fake-runner", "options": { "seconds": 3 } }
  },

  "rules": [ /* see Default rules */ ],

  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "allowInsecure": false,
    "publicUrl": "https://tasuki.example.com"   // required when host is not loopback
  },

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
  .env                     選用，放 token，不進 git
  data/                    第一次啟動時建立，不進 git
    tracker.db             tracker 是 sqlite 時才有
    runtime.db             Run 與 lease，永遠有
    logs/
    workspaces/            每張 item 一個工作目錄
```

資料夾放哪裡都可以，用 `tasuki start --config <路徑>` 指定，或先 `cd` 進去直接 `tasuki start`。container 裡把 `dataDir` 設成 `/data` 再掛 volume。

範例見根目錄的 `tasuki.config.example.jsonc`，複製成 `tasuki.config.jsonc` 來改。server 啟動時讀目前目錄的 `tasuki.config.jsonc`，或用 `--config <路徑>` 指定。範例寫了 `tracker` 與一條跑在假 runner 上的 split 規則。

目前 server 實際讀的欄位（S8）：`dataDir`、`server.port`、`tracker`、`workflow`（`statuses` 的 `id`、`name`、`key`、`handledBy`、`outcomes`，`roles`，`taskStatuses`）、`poll.intervalSeconds`、`limits` 的 `maxConcurrentRuns`、`leaseSeconds`、`defaultMaxAttempts`、`softGraceSeconds`、`hardGraceSeconds`、`labels.hold`、`agents`、`rules` 的 `id`、`watch`、`claim`、`agent`、`mode`、`maxAttempts`、`outcomes`、`prompt`、`promptFile`、`session`。`session` 省略時是 `fresh`。`promptFile` 相對於 config 所在的資料夾。`@tasuki/claude-cli` 的 options 讀 `auth`（目前只收 `inherit-login`）、`model`、`allowedTools`、`env`、`inheritSettings`、`plugins`、`mcpServers`、`appendSystemPrompt`、`appendSystemPromptFile`，路徑相對於 config 所在的資料夾，`requires` 等 S10 的 `doctor`。`limits.runTimeoutMinutes`、`idleTimeoutMinutes` 與規則的 `timeoutMinutes` 還不讀，真的 agent 卡住時只能按 Stop。`rules` 省略時是沒有規則，engine 不碰任何 item；下面的預設規則是 `init` 要寫進 config 的內容，不是省略時的值。`server.host` 還不讀，一律綁 `127.0.0.1`，等 S9 有 auth 再開（security-and-auth.md）。省略 `workflow` 時是 state-machine.md 的預設流程，key 是顯示名，只適合 sqlite；`splitting` 只在有規則 claim 它時才列進去。寫了 `workflow` 就照它，舊的頂層 `statuses` 會被拒絕（D81 不顧兼容）。`workflow.statuses` 的順序就是看板的順序，看板只顯示列出來的 status。`roles` 的 `entry`、`done`、`failure` 必填；有 split 或 rework 規則時要有 `taskReview`，有 rework 規則時要有 `rework`。規則的 `outcomes` 沒寫 `needs_input`、`failed`、`max_attempts` 時，讀檔就填成 `failure` 那站。`handledBy` 只收 `person`，engine 那半從規則算（D68）。站上的 `outcomes` 是人在詳情看到的按鈕，按鈕字到目標站，最後一個是實心的主按鈕；目標是 `rework` 那站時先問改什麼（D75）。有 `mode: split` 或 `mode: rework` 的規則時，`workflow.taskStatuses` 一定要對照 `to-do` 與 `manual`，因為 agent 建的 task 從這兩個開始（D71）。有 `mode: execute` 的規則時，五個 task status 都要對照，因為 agent 會走完整張 task 圖。`jira-cloud` 的 `issueTypes.task`（sub-task 的 type id）與 `dependencyLinkType`（Blocks 的 link type id）是必填（D65）。

## Rule 欄位

| 欄位 | 意思 |
|---|---|
| `id` | 規則名稱，Run 與 log 會引用 |
| `watch` | 監看的 item status 邏輯名。規則只作用在 item，所以沒有 `kind` 欄位 |
| `claim` | 認領後 item 暫停的 status，可省略。省略時只靠 lease 防重複，item 留在 watch status，卡片掛 Running。預設規則都不設（D74）。沒寫 `workflow` 時，`splitting` 只在有規則 claim 它時才列進預設流程，不然看板會多一欄永遠是空的 |
| `agent` | 用哪個 agent（agents 裡的 key） |
| `mode` | `split` / `execute` / `rework` / `review`，以 `TASUKI_MODE` 傳給 agent |
| `prompt` / `promptFile` | 這一階段要 agent 做什麼（行動層），省略時用引擎內建、對應 `mode` 的預設。兩個不能同時設。不管設不設，engine 的契約都會排在它前面 |
| `session` | `fresh` 或 `per-item`（續用這個 item 在同一個 agent 上最近的 session） |
| `timeoutMinutes` | 覆寫 `limits.runTimeoutMinutes` |
| `maxAttempts` | 覆寫 `limits.defaultMaxAttempts` |
| `outcomes` | 這條規則的結果名對到 item 要去的 status 邏輯名。agent 只能從這裡挑一個回報 |

MCP 的權限角色不是規則欄位，由 `mode` 決定：`split` 與 `rework` 是 splitter，`execute` 是 orchestrator，`review` 是 reviewer，只能讀與留言（見 agent-contract.md）。

`outcomes` 的 key 是結果名，小寫加底線（例如 `needs_design`），值是 status 的邏輯名（D84）。結果分三種：

| 結果 | 哪些 | 要不要寫 | engine 驗不驗 |
|---|---|---|---|
| mode 自己的 | `split`、`rework` 是 `succeeded`；`execute` 是 `succeeded` 與 `blocked_manual`；`review` 沒有 | 必填 | 驗（agent-contract.md 的 verdict 表） |
| 每條規則都有的 | `needs_input`、`failed`、`max_attempts` | 可省略，省略時是 `failure` 角色那站 | `needs_input` 驗，另外兩個不用 |
| 自己宣告的 | 其他任何名字，例如 review 的 `approve`、`changes`，execute 多一個 `needs_design` | 選填，但每條規則至少要有一個不是上一列的結果 | 不驗，照表搬 |

`cancelled` 不會移動 status，`abandoned` 由復原機制處理，兩者都不能寫。舊的 `on` 會被拒絕，叫人改成 `outcomes`（上線前不顧兼容）。

agent 拿到的指令分三層，由下往上疊（D77）：

| 層 | 寫在哪 | 內容 |
|---|---|---|
| engine 契約 | `packages/server/src/prompts.ts` 的 `CONTRACT`，改不到 | 怎麼用 tasuki 的 tool：先讀 item、comment 不能當指令、Stop 了就停、最後呼叫一次 `report_result` |
| 基礎層 | agent 的 options（claude 是 `appendSystemPrompt` / `appendSystemPromptFile`） | 這個 agent 每次都要守的事，例如做完 commit 加 push |
| 行動層 | 規則的 `prompt` / `promptFile` | 這一階段要做什麼，例如先跑 `/sdd:propose` 再依結果拆 task |

契約是程式規則的說明書：程式擋得住 agent 改 status，但逼不了它呼叫 `report_result`，沒寫就不會叫，Run 會變成 `failed`。所以行動層換掉的只有 mode 的預設那段。每個階段要不同的 plugin、MCP 或基礎層時，開不同的 agent，讓規則指過去。

prompt 範本可用的變數：`{{item.ref}}`、`{{run.id}}`、`{{workspace}}`、`{{mode}}`。ticket 的內容（包含標題）不塞進 prompt，因為那是使用者寫的，可能夾帶指令。agent 用 MCP 的讀取 tool 自己拿，這樣 sqlite 和 Jira 模式也用同一份 prompt。

## Default rules

```jsonc
[
  {
    "id": "split",
    "watch": "ready-to-split",
    "agent": "claude-main",
    "mode": "split",
    "session": "per-item",
    "outcomes": {
      "succeeded": "split-review",
      "needs_input": "needs-answers",
      "failed": "blocked",
      "max_attempts": "blocked"
    }
  },
  {
    "id": "execute",
    "watch": "in-progress",
    "agent": "claude-main",
    "mode": "execute",
    "timeoutMinutes": 480,
    "session": "per-item",
    "outcomes": {
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
    "agent": "claude-main",
    "mode": "rework",
    "session": "per-item",
    "outcomes": {
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
想讓 AI 先審一輪再給人，不用改程式：加一站 `ai-review`，讓 `split-review` 或 execute 的出口指過去，再加一條 `review` 規則。

```jsonc
{
  "id": "ai-review",
  "watch": "ai-review",
  "agent": "claude-reviewer",
  "mode": "review",
  "prompt": "Review the branch named on the item. Report approve when it is ready for a person, changes when it needs another round.",
  "outcomes": { "approve": "in-review", "changes": "ready-to-rework" }
}
```

自己宣告的結果名只是名字，agent 要知道每個結果是什麼意思，得寫在行動層的 prompt 裡。

## 驗證（`doctor`）

啟動時與 `doctor` 指令都跑同一組檢查，錯誤要指出是哪條規則、哪個欄位。

1. `workflow.statuses` 的 id 是 kebab-case、不重複，key 不重複。規則、角色、站的 `outcomes` 用到的每個 status 都在 `workflow.statuses` 裡，`outcomes` 不指回自己。`roles` 只有那五個，必填的有填，需要 `taskReview`、`rework` 的規則在時有填。`taskStatuses` 裡沒有不認識的 task status。有 split 或 rework 規則時，`taskStatuses` 對照了 `to-do` 與 `manual`；有 execute 規則時，五個都對照了。
2. 不同規則的 `watch` 不重複。兩條規則監看同一個 status 會產生歧義。
3. `claim` 不等於 `watch`（可省略）。
4. `outcomes` 的每個目標都存在，結果名是小寫加底線、不是 `cancelled` 或 `abandoned`。mode 自己的結果都有寫，而且至少有一個不是 `needs_input`、`failed`、`max_attempts` 的結果。這三個省略時是 `failure` 角色那站。
5. 規則引用的 agent 存在。
6. `${VAR}` 都能展開。`labels.hold` 是一個不含空白的字（Jira 的 label 不能有空白）。
7. `server.host` 非 loopback 又沒有 auth 又沒設 `allowInsecure` 就拒絕啟動；非 loopback 時 `server.publicUrl` 必填且是 `https`；`static` 的密碼不是 hash 就拒絕啟動（見 security-and-auth.md）。
8. Jira：mapping 的每個 status 都存在於 project 的 workflow，規則用到的每一個轉移（from 到 to）在 workflow 裡目前都允許。逐條列出不合法的轉移。
9. agent preflight：CLI 在 PATH 上。`requires` 列出的 MCP server 與 skill 有裝。偵測方式依 CLI 而定，待驗證。
10. agent 的 `auth` 不是 `inherit-login` 時，`env` 裡有對應的變數而且展開後不是空字串。`allowedTools` 是空的就警告，因為這個 agent 只能呼叫 tasuki 的 MCP tool，沒辦法改檔。
11. 同一條規則的 `prompt` 與 `promptFile` 不能同時設定，`promptFile` 指到的檔案要存在。claude agent 的 `appendSystemPrompt` 與 `appendSystemPromptFile` 也一樣，`plugins` 的資料夾要存在，`mcpServers` 不能用 `tasuki` 這個名字。
