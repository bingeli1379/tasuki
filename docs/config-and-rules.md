# Config and rules

狀態：草稿。欄位與預設值還沒逐項確認。

使用者只需要改這一份檔案，就能換 tracker、對應 status、換 agent、改規則。格式用 JSONC（JSON 加註解），再提供 `$schema` 讓編輯器自動補全。
熱重載：新的 Run 用新 config，執行中的 Run 沿用啟動時的快照。新 config 驗證失敗就保留舊的，並在 API 與 log 上回報。
`${VAR}` 會展開成環境變數，找不到就報錯。config 裡不放明文 token。

## 形狀

```jsonc
{
  "$schema": "./tasuki.config.schema.json",
  "version": 1,

  "tracker": {
    "kind": "sqlite",                          // "sqlite" | "jira-cloud"
    "sqlite": { "path": "./data/tracker.db" },
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
      "needs-rework": "Needs Rework",
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
    "runTimeoutMinutes": 60,
    "defaultMaxAttempts": 3
  },

  "workspace": { "root": "./workspaces", "cleanup": "never" },   // "never" | "on-done"

  "agents": {
    "claude-main": {
      "kind": "claude-cli",
      "auth": "inherit-login",                 // "api-key" | "inherit-login" | "oauth-token"
      "model": null,
      "allowedTools": [],
      "env": { "GITLAB_TOKEN": "${GITLAB_TOKEN}" },   // passed to the spawned CLI only
      "requires": { "mcpServers": [], "skills": [] }   // optional preflight, see doctor
    },
    "codex-main": { "kind": "codex-cli", "env": {} }
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

## Rule 欄位

| 欄位 | 意思 |
|---|---|
| `id` | 規則名稱，Run 與 log 會引用 |
| `kind` | v1 只有 `item` |
| `watch` | 監看的 status 邏輯名 |
| `claim` | 認領後 item 暫停的 status，可省略。省略時只靠 lease 防重複 |
| `role` | `splitter` 或 `orchestrator`，決定 MCP tool 權限 |
| `agent` | 用哪個 agent（agents 裡的 key） |
| `mode` | `split` / `execute` / `rework`，以 `TASUKI_MODE` 傳給 agent |
| `prompt` / `promptFile` | 給 agent 的指令範本 |
| `session` | `fresh` 或 `per-item`（續用這個 item 在同一個 agent 上最近的 session） |
| `timeoutMinutes` | 覆寫 `limits.runTimeoutMinutes` |
| `maxAttempts` | 覆寫 `limits.defaultMaxAttempts` |
| `on` | outcome 對應到的 status 邏輯名 |

`on` 可以設的 key 是 `succeeded`、`needs_input`、`blocked_manual`、`failed`、`max_attempts`。`cancelled` 不會移動 status，`abandoned` 由復原機制處理，兩者都不用設。

prompt 範本可用的變數：`{{item.ref}}`、`{{item.title}}`、`{{run.id}}`、`{{workspace}}`、`{{mode}}`。item 的內容不塞進 prompt，agent 用 MCP 的讀取 tool 自己拿，這樣 sqlite 和 Jira 模式用同一份 prompt。

## Default rules

```jsonc
[
  {
    "id": "split",
    "kind": "item",
    "watch": "ready-to-split",
    "claim": "splitting",
    "role": "splitter",
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
    "kind": "item",
    "watch": "in-progress",
    // no claim status: dedupe by lease
    "role": "orchestrator",
    "agent": "claude-main",
    "mode": "execute",
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
    "kind": "item",
    "watch": "needs-rework",
    "claim": "splitting",
    "role": "splitter",
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

不要 split-review 這個關卡的人，把 `split` 與 `rework` 的 `succeeded` 改成 `in-progress`。
想讓 AI 先審一輪再給人，另外加一條 `watch: "in-review"` 的規則即可，不用改程式。

## 驗證（`doctor`）

啟動時與 `doctor` 指令都跑同一組檢查，錯誤要指出是哪條規則、哪個欄位。

1. 規則用到的每個 status 都存在於對應 kind 的 `statuses`。
2. 不同規則的 `watch` 不重複。兩條規則監看同一個 status 會產生歧義。
3. `claim` 不等於 `watch`（可省略）。
4. `on` 的每個目標都存在，而且規則可能產生的每個 outcome 都有目標（`blocked_manual` 對 split / rework 不會發生，可省略）。
5. 規則引用的 agent 存在。
6. `${VAR}` 都能展開。
7. `server.host` 非 loopback 又沒有 auth 又沒設 `allowInsecure` 就拒絕啟動（見 security-and-auth.md）。
8. Jira：mapping 的每個 status 都存在於 project 的 workflow，規則用到的每一個轉移（from 到 to）在 workflow 裡目前都允許。逐條列出不合法的轉移。
9. agent preflight：CLI 在 PATH 上。`requires` 列出的 MCP server 與 skill 有裝。偵測方式依 CLI 而定，待驗證。
