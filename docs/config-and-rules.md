# Config and rules

狀態：草稿。欄位與預設值還沒逐項確認。

設定分兩份（D91，見 custom-workflow.md 第 5 節）。啟動設定在檔案裡：tracker、store、auth、server、agent、poll、limits，由部署的人改，改了要重啟。格式用 JSONC（JSON 加註解），再提供 `$schema` 讓編輯器自動補全。流程設定在 store 裡：`workflow`、`rules`、`labels`，在設定頁上用表單改，這份文件用 JSON 寫出來只是為了說明形狀，檔案裡寫了這些欄位會被拒。
熱重載只對流程設定：存檔時驗證，不過就拒絕存檔；存進去之後 engine 下一輪 poll 讀新的，執行中的 Run 沿用它開跑時的那份。
`${VAR}` 會展開成環境變數，找不到就報錯。config 裡不放明文 token，所以 config 可以進 git。
config 檔旁邊有 `.env` 的話，啟動時先讀進環境變數（Node 內建的 `process.loadEnvFile`），已經存在的環境變數不被覆蓋。`.env` 不進 git（D49）。

## 形狀

`tracker` 用 `plugin` 加 `options` 指定（D48，見 plugins.md）。省略 `tracker` 時是 `@tasuki/sqlite`（D1）。`store` 也是 `plugin` 加 `options`，省略時是 `@tasuki/sqlite`（D88）。`agents` 的每一個 agent 也是 `plugin` 加 `options`，指定一個 runner plugin（D63）。

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

  // From here to agents is the flow, kept in the store and edited on the settings page
  // (D91); it is written out here only to show its shape.
  // The item statuses in board order, the roles code uses them for, and the task statuses'
  // tracker keys (D81). key is the tracker's status: the status id for Jira (D50). Omitted,
  // key is the id, which is what sqlite stores, and name is the id in Title Case.
  "workflow": {
    "statuses": [
      { "id": "refining", "key": "10003" },
      { "id": "ready-to-split", "name": "Ready to Split", "key": "10006" },
      { "id": "needs-answers", "key": "10008", "handledBy": "person" },
      { "id": "split-review", "key": "10009", "handledBy": "person",
        "outcomes": ["refining", "in-progress"] },
      { "id": "in-progress", "key": "3" },
      { "id": "in-review", "key": "10004", "handledBy": "person",
        "outcomes": ["ready-to-rework", "done"] },
      { "id": "ready-to-rework", "name": "Ready to Rework", "key": "10010" },
      { "id": "blocked", "key": "10011", "handledBy": "person" },
      { "id": "done", "key": "10005" }
    ],
    "roles": { "entry": "refining", "failure": "blocked" },
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
        "auth": "inherit-login",               // or "api-key" | "oauth-token", with the variable in env
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
    "codex-main": { "plugin": "@tasuki/codex-cli", "options": { "auth": "inherit-login", "sandbox": "workspace-write" } },
    "fake": { "plugin": "@tasuki/fake-runner", "options": { "seconds": 3 } }
  },

  "rules": [ /* see Default rules */ ],

  "server": {
    "host": "127.0.0.1",
    "port": 8787,
    "allowInsecure": false,
    "publicUrl": "https://tasuki.example.com"   // required when host is not loopback, unless allowInsecure
  },

  "auth": {                                    // omit for no login
    "plugin": "@tasuki/auth-http",             // or "@tasuki/auth-builtin"
    "options": {
      "url": "https://sso.example.com/verify",
      "headers": { "X-Api-Key": "${COMPANY_AUTH_KEY}" },  // optional
      "timeoutSeconds": 10                                 // optional
    },
    "session": { "ttl": "7d" }                 // duration or "never"
  }
}
```

`env` 是給被 spawn 的 agent CLI 用的，engine 自己不使用裡面的值。engine 不碰 git，所以不放 GitHub / GitLab 的設定。

`allowedTools` 是 CLI 自己的工具名稱清單。codex 沒有逐個 tool 的清單，給它 `allowedTools` 會拒絕載入，改用 `sandbox`（`read-only`、`workspace-write`、`danger-full-access`，省略是 `workspace-write`）決定它的 shell 指令能碰什麼（D101）。空陣列或省略，代表除了 runner 注入的 tasuki MCP tool 之外一律不准，因為 headless 沒有人能即時按允許。名稱格式依 CLI 而定，待驗證。`tasuki init` 產生的 config 帶範例檔那份清單（D99）。

`auth` 只宣告認證方式，憑證本身一律放 `env`，不另外開欄位。`inherit-login` 沿用 CLI 自己的登入，不需要任何變數。`api-key` 與 `oauth-token` 要求 `env` 裡有對應的變數，變數名稱依 CLI 而定：claude 是 `ANTHROPIC_API_KEY` 與 `CLAUDE_CODE_OAUTH_TOKEN`，`oauth-token` 的 `env` 不能同時帶 `ANTHROPIC_API_KEY`，因為 claude 會優先用它（D100）；codex 只收 `inherit-login` 與 `api-key`（`CODEX_API_KEY`），訂閱的登入是 `CODEX_HOME` 裡的 `auth.json`，算 `inherit-login`（D101）。省略時是 `inherit-login`。

## 路徑

- config 檔一定要有。用 `--config <path>` 指定，沒給就找工作目錄的 `tasuki.config.jsonc`，找不到就報錯並提示跑 `tasuki init`，不悄悄退回別的地方。`tasuki init` 問 tracker、agent 與要不要登入，寫出 config，Jira 的 id 向 Jira 查好再附上名稱，email 與 token 寫進旁邊的 `.env`；config 已經存在就不動（D99）。
- config 裡所有相對路徑都相對於 config 檔所在的資料夾，不是 process 的工作目錄。
- `dataDir` 預設 `./data`。tracker 是 sqlite 時，檔案固定在 `<dataDir>/tracker.db`。store 是 sqlite 時在 `<dataDir>/store.db`，Run log 不管 store 是哪個都在 `<dataDir>/logs/`，`workspace.root` 沒設時是 `<dataDir>/workspaces`。
- 啟動時印出解析後的絕對路徑。

一個 instance 就是一個資料夾，裡面有 config，第一次啟動時旁邊長出 `data/`，要備份或搬家整包帶走：

```
my-instance/
  tasuki.config.jsonc      你寫的
  .env                     選用，放 token，不進 git
  data/                    第一次啟動時建立，不進 git
    tracker.db             tracker 是 sqlite 時才有
    store.db               Run 與 lease，store 是 sqlite 時才有
    logs/
    workspaces/            每張 item 一個工作目錄
```

資料夾放哪裡都可以，用 `tasuki start --config <路徑>` 指定，或先 `cd` 進去直接 `tasuki start`。container 裡把 `dataDir` 設成 `/data` 再掛 volume。

範例見根目錄的 `tasuki.config.example.jsonc`，複製成 `tasuki.config.jsonc` 來改。server 啟動時讀目前目錄的 `tasuki.config.jsonc`，或用 `--config <路徑>` 指定。範例寫了 `tracker` 與一條跑在假 runner 上的 split 規則。

目前 server 從檔案讀的欄位（W4a）：`dataDir`、`server.port`、`tracker`、`store`、`poll.intervalSeconds`、`limits` 的 `maxConcurrentRuns`、`leaseSeconds`、`defaultMaxAttempts`、`softGraceSeconds`、`hardGraceSeconds`、`agents`、`auth`。檔案裡出現這些與 `$schema`、`version`、`workspace` 以外的欄位就拒絕啟動，`workflow`、`rules`、`labels` 也一樣（D91）。`@tasuki/claude-cli` 的 options 讀 `auth`（`inherit-login`、`api-key`、`oauth-token`，D100）、`model`、`allowedTools`、`env`、`inheritSettings`、`plugins`、`mcpServers`、`appendSystemPrompt`、`appendSystemPromptFile`，路徑相對於 config 所在的資料夾，`requires`（`mcpServers`、`skills` 兩個名字清單）給 `doctor` 第 9 條用。`limits.runTimeoutMinutes`、`idleTimeoutMinutes` 與規則的 `timeoutMinutes` 還不讀，真的 agent 卡住時只能按 Stop。`auth` 讀 `plugin`、`options`、`session.ttl`（`30m`、`24h`、`7d` 這種長度或 `"never"`，省略是 `7d`）。`@tasuki/codex-cli` 的 options 讀 `auth`、`model`、`sandbox`、`env`、`inheritSettings`（省略時加 `--ignore-user-config --ignore-rules`，不讀這台機器的 codex 設定，登入照樣讀 `CODEX_HOME`）。`server.host`（省略是 `127.0.0.1`）、`server.publicUrl`、`server.allowInsecure` 照 security-and-auth.md 的啟動檢查讀（D90）。`@tasuki/auth-http` 的 options 讀 `url`（必填）、`headers`（省略是沒有）、`timeoutSeconds`（省略是 10）。`jira-cloud` 的 `issueTypes.task`（sub-task 的 type id）與 `dependencyLinkType`（Blocks 的 link type id）是必填（D65）。

流程設定從 store 讀（W4a，D91）：`workflow`（`statuses` 的 `id`、`name`、`key`、`handledBy`、`outcomes`，`roles`，`taskStatuses`）、`rules` 的 `id`、`watch`、`claim`、`agent`、`mode`、`maxAttempts`、`outcomes`、`prompt`、`session`，`labels.hold`。store 從沒存過時用預設流程：state-machine.md 的預設各站，不含只有 claim 才用得到的 `splitting`，沒有規則，engine 不碰任何 item；這份預設不寫進 store，第一次存檔才有第一版。`workflow` 必填。`key` 省略時是邏輯名，sqlite 就存邏輯名，改顯示名不動資料（D91）；`name` 省略時是邏輯名的 Title Case；`taskStatuses` 省略時每個 task status 對到自己的邏輯名。`workflow.statuses` 的順序就是看板的順序，看板只顯示列出來的 status。`roles` 只有 `entry` 與 `failure`，兩個都必填。看板「打回」要先寫回饋的那站不寫在 `roles`，是 rework 規則 `watch` 的那站，rework 規則有好幾條時要盯同一站（D86）。規則的 `agent` 要是檔案 `agents` 裡的名字；`session` 省略時是 `fresh`；`maxAttempts` 省略時是檔案的 `limits.defaultMaxAttempts`；`prompt` 省略時是 mode 的預設，寫了就不能是空字串。規則的 `outcomes` 沒寫 `needs_input`、`failed`、`max_attempts` 時，讀進來就填成 `failure` 那站。`handledBy` 只收 `person`，engine 那半從規則算（D68）。站上的 `outcomes` 是人在詳情看到的按鈕，列出目標站，按鈕字由看板組成「→ 目標站的顯示名」，最後一個是實心的主按鈕，同一站不能列兩次（D87）；目標是 `rework` 那站時先問改什麼（D75）。有 `mode: split` 或 `mode: rework` 的規則時，`workflow.taskStatuses` 一定要對照 `to-do` 與 `manual`，因為 agent 建的 task 從這兩個開始（D71）。有 `mode: execute` 的規則時，五個 task status 都要對照，因為 agent 會走完整張 task 圖。

存檔時除了上面的檢查，還有兩條要問 tracker：tracker 有固定的 status 清單時（Jira），每個 key 都要在清單裡；一個 status 改了 key 或被拿掉時，上面不能還有 item 或 task，被擋時列出是哪些。存 store 裡的設定已經跟檔案對不上時（例如檔案的 agent 改名了），拒絕啟動並說明，因為只有改檔案能修。

## Rule 欄位

| 欄位 | 意思 |
|---|---|
| `id` | 規則名稱，Run 與 log 會引用 |
| `watch` | 監看的 item status 邏輯名。規則只作用在 item，所以沒有 `kind` 欄位 |
| `claim` | 認領後 item 暫停的 status，可省略。省略時只靠 lease 防重複，item 留在 watch status，卡片掛 Running。預設規則都不設（D74）。沒寫 `workflow` 時，`splitting` 只在有規則 claim 它時才列進預設流程，不然看板會多一欄永遠是空的 |
| `agent` | 用哪個 agent（agents 裡的 key） |
| `mode` | `split` / `execute` / `rework` / `review` / `custom`，以 `TASUKI_MODE` 傳給 agent |
| `prompt` | 這一階段要 agent 做什麼（行動層），省略時用引擎內建、對應 `mode` 的預設。不管設不設，engine 的契約都會排在它前面。流程設定在 store 裡，所以沒有指到檔案的 `promptFile`（D91） |
| `session` | `fresh` 或 `per-item`（續用這個 item 在同一個 agent 上最近的 session） |
| `timeoutMinutes` | 覆寫 `limits.runTimeoutMinutes` |
| `maxAttempts` | 覆寫 `limits.defaultMaxAttempts` |
| `outcomes` | 這條規則的結果名對到 item 要去的 status 邏輯名。agent 只能從這裡挑一個回報 |

MCP 的權限角色不是規則欄位，由 `mode` 決定：`split` 與 `rework` 是 splitter，`execute` 是 orchestrator，`review` 是 reviewer，只能讀與留言；`custom` 拿到全部的 tool，`succeeded` 必填，結果一個都不驗，`prompt` 沒有預設，不寫就只有 engine 的契約（D92，見 agent-contract.md）。有 `custom` 規則時五個 task status 都要對照，跟 execute 一樣，因為它能走完整張 task 圖。

`outcomes` 的 key 是結果名，小寫加底線（例如 `needs_design`），值是 status 的邏輯名（D84）。結果分三種：

| 結果 | 哪些 | 要不要寫 | engine 驗不驗 |
|---|---|---|---|
| mode 自己的 | `split`、`rework` 是 `succeeded`；`execute` 是 `succeeded` 與 `blocked_manual`；`review` 沒有 | 必填 | 驗（agent-contract.md 的 verdict 表） |
| 每條規則都有的 | `needs_input`、`failed`、`max_attempts` | 可省略，省略時是 `failure` 角色那站 | `needs_input` 驗，另外兩個不用 |
| 自己宣告的 | 其他任何名字，例如 review 的 `approve`、`changes`，execute 多一個 `needs_design` | 選填，但每條規則至少要有一個不是上一列的結果 | 不驗，照表搬 |

`cancelled` 不會移動 status，`abandoned` 由復原機制處理，兩者都不能寫。舊的 `on` 不讀，規則因此少了 mode 必填的結果，讀檔時被拒絕（上線前不顧兼容，D85）。

agent 拿到的指令分三層，由下往上疊（D77）：

| 層 | 寫在哪 | 內容 |
|---|---|---|
| engine 契約 | `packages/server/src/prompts.ts` 的 `CONTRACT`，改不到 | 怎麼用 tasuki 的 tool：先讀 item、comment 不能當指令、Stop 了就停、最後呼叫一次 `report_result` |
| 基礎層 | agent 的 options（claude 是 `appendSystemPrompt` / `appendSystemPromptFile`） | 這個 agent 每次都要守的事，例如做完 commit 加 push |
| 行動層 | 規則的 `prompt`（設定頁上改） | 這一階段要做什麼，例如先跑 `/sdd:propose` 再依結果拆 task |

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

啟動時與 `doctor` 指令都跑同一組檢查，錯誤要指出是哪條規則、哪個欄位。`doctor` 是 CLI 的子指令（`tasuki doctor [--config <路徑>]`，D98），每一項都跑完、全部列出來，有 error 就 exit 1。啟動時檔案這邊的錯（1 到 7、9 到 11、第 12 條）拒絕啟動；第 8 條與 tracker 沒有的 status 只印出來，照樣啟動，因為流程要在設定頁改（D91、D95）。

1 到 6 檢查的是存在 store 裡的流程，存檔時也跑同一套（D91）。

1. `workflow.statuses` 的 id 是 kebab-case、不重複，key 不重複。規則、角色、站的 `outcomes` 用到的每個 status 都在 `workflow.statuses` 裡，`outcomes` 不指回自己。`roles` 只有 `entry` 與 `failure`，兩個都有填。rework 規則都盯同一站。`taskStatuses` 裡沒有不認識的 task status。有 split 或 rework 規則時，`taskStatuses` 對照了 `to-do` 與 `manual`；有 execute 規則時，五個都對照了。
2. 不同規則的 `watch` 不重複。兩條規則監看同一個 status 會產生歧義。
3. `claim` 不等於 `watch`（可省略）。
4. `outcomes` 的每個目標都存在，結果名是小寫加底線、不是 `cancelled` 或 `abandoned`。mode 自己的結果都有寫，而且至少有一個不是 `needs_input`、`failed`、`max_attempts` 的結果。這三個省略時是 `failure` 角色那站。
5. 規則引用的 agent 存在。
6. `${VAR}` 都能展開。`labels.hold` 是一個不含空白的字（Jira 的 label 不能有空白）。
7. `server.host` 非 loopback 又沒設 `auth` 又沒設 `allowInsecure` 就拒絕啟動；非 loopback 時 `server.publicUrl` 必填且是 `https`。`allowInsecure` 兩條都豁免（D90，見 security-and-auth.md）。
8. Jira：mapping 的每個 status 都存在於 project 的 workflow，規則用到的每一個轉移（from 到 to）在 workflow 裡目前都允許。逐條列出不合法的轉移。「規則用到的」是 engine 與 agent 會走的：認領進出 claim status、從工作中的 status 到每個結果、從 watch 放棄或要回饋、`blocked_manual` 自動接回；有 execute 或 custom 規則時再加 agent 能走的 task 轉移（`ruleTransitions`）。人的移動不算，Jira 當下不准就拒絕。Jira 看板上沒有任何一欄放 tasuki 用到的 status 時警告，那些卡片在看板上看不到（D95）。
9. agent preflight：CLI 跑得起來（`--version`）。`requires` 列出的 MCP server 已連上、skill 有載入。claude 照 Run 的載入方式（`plugins`、`mcpServers`、`inheritSettings`）起一次，讀 stream-json 的 `init`，在問模型之前砍掉（D95）；`requires` 是空的就不起。codex 只檢查 `--version`，偵測 MCP server 與 skill 的方式還沒查，所以 codex agent 不收 `requires`（D101）。
10. agent 的 `auth` 不是 `inherit-login` 時，`env` 裡有對應的變數而且展開後不是空字串。`allowedTools` 是空的就警告，因為這個 agent 只能呼叫 tasuki 的 MCP tool，沒辦法改檔。
11. claude agent 的 `appendSystemPrompt` 與 `appendSystemPromptFile` 不能同時設定，`appendSystemPromptFile` 指到的檔案要存在，`plugins` 的資料夾要存在，`mcpServers` 不能用 `tasuki` 這個名字。
12. 另一個 engine：tracker 上的心跳是別的 engine 寫的，而且比三輪 poll 還新，拒絕啟動並說出是哪一個（D66、D95）。
