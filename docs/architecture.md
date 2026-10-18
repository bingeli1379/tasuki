# Architecture

## 目標

- 一個後端 engine 定時檢查 tracker，命中規則就派 agent 做事，結果寫回。
- tracker 可抽換：沒有 Jira 也能用 sqlite 在本機跑。選哪個就只看哪個，不同步。
- 規則、status 對照、agent 都在一份 config 裡，使用者不用寫 API。
- 前端只是 API 的一個 client，在 sqlite 模式下用來看進度與操作。

不做的事見 plan.md 的 non-goals。

## 分層

Clean Architecture / ports and adapters。Domain 不認識 Jira、sqlite、claude。

```mermaid
flowchart LR
  FE["Frontend (Vue SPA)"] --> REST
  AG["Agent CLI"] --> MCP

  subgraph Driving["Driving adapters"]
    REST["REST API"]
    MCP["MCP facade (http)"]
    POLL["Poller"]
  end

  subgraph App["Application"]
    UC["Use cases"]
    DOM["Domain: state machine, rules, outcome validation"]
  end

  subgraph Driven["Driven adapters"]
    ST["StoragePort: sqlite or jira-cloud"]
    RT["RuntimeStorePort: local sqlite"]
    RUN["RunnerPort: claude-cli, codex-cli"]
    AUTH["AuthPort: none, static, http"]
    CLK["Clock"]
  end

  REST --> UC
  MCP --> UC
  POLL --> UC
  UC --> DOM
  UC --> ST
  UC --> RT
  UC --> RUN
  UC --> AUTH
  UC --> CLK
  RUN -. spawns .-> AG
```

要點：

- 狀態轉移、權限、驗證只寫在 use case 與 domain 一處，REST、MCP、Poller 進來都過同一關。
- port 的介面定義在 application 層，adapter 去實作它。
- 真正需要寫成程式介面的只有三個：Storage、Runner、Auth。stage 是 config，model 是 agent 的參數，前端是 API 的 client。
- 所有用到現在時間的地方都從 `Clock` 拿，不直接呼叫 `Date.now()`。

## Ports

草稿，簽名之後以程式碼為準。

```ts
interface StoragePort {
  list(kind: Kind, status: string): Promise<WorkUnit[]>
  get(ref: Ref): Promise<WorkUnit>
  children(item: Ref): Promise<WorkUnit[]>
  dependencies(item: Ref): Promise<Dependency[]>
  comments(target: Ref): Promise<Comment[]>
  // compare-and-set: throws StatusConflict if current status != expectedFrom
  transition(ref: Ref, expectedFrom: string, to: string, actor: Actor): Promise<void>
  addComment(c: NewComment): Promise<void>
  createTask(item: Ref, t: NewTask): Promise<WorkUnit>
  updateTask(ref: Ref, patch: TaskPatch): Promise<void>
  setLabels(ref: Ref, labels: string[]): Promise<void>
}

interface RuntimeStorePort {
  createRun(r: NewRun): Promise<Run>          // fails if target already has a live Run
  renewLease(id: string, until: string): Promise<void>
  finishRun(id: string, outcome: Outcome, usage?: Usage): Promise<void>
  requestCancel(id: string, mode: 'soft' | 'hard', by: Actor): Promise<void>
  liveRuns(): Promise<Run[]>
  runsFor(target: Ref): Promise<Run[]>
  getState(key: string): Promise<string | undefined>   // e.g. 'paused'
  setState(key: string, value: string): Promise<void>
}

interface RunnerPort {
  start(spec: RunSpec): RunHandle    // spawn headless CLI, returns handle
}
interface RunHandle {
  readonly sessionId: Promise<string | undefined>
  readonly exit: Promise<{ code: number | null; signal: string | null }>
  terminate(grace: 'soft' | 'hard'): Promise<void>
}

interface AuthPort {
  login(credentials: unknown): Promise<Identity>
  verify(sessionToken: string): Promise<Identity | undefined>
}
```

## 一次規則執行

```mermaid
sequenceDiagram
    participant P as Poller
    participant U as Use cases
    participant S as StoragePort
    participant R as RuntimeStore
    participant X as RunnerPort
    participant A as Agent CLI
    participant M as MCP facade

    P->>U: tick
    U->>S: list(kind, watch status)
    S-->>U: candidates
    Note over U: skip hold, skip items with a live Run, respect limits and pause
    U->>R: createRun (lease)
    U->>S: transition(ref, watch to claim) with compare-and-set
    U->>X: start(agent, cwd, env, prompt, resume session?)
    X->>A: spawn headless CLI
    A->>M: get_item, list_tasks, list_comments
    A->>M: add_comment, create_task, set_task_status
    M->>U: use case calls, scoped by run token
    loop while running
        U->>R: renewLease
        U->>S: check status and hold (human override?)
    end
    A->>M: report_result(verdict)
    X-->>U: process exit
    Note over U: validate verdict, outcome = f(verdict, exit, state)
    U->>S: transition(ref, claim to target) with compare-and-set
    U->>R: finishRun(outcome, usage)
```

順序刻意是「先建 Run（lease）、再轉 claim status」。中間當機的話，只會留下一個會過期的 Run，item 還在原本的 status，不會卡住。

## 兩個 store

```mermaid
flowchart LR
  subgraph TS["Tracker store (sqlite or Jira)"]
    WU["WorkUnit"]
    DEP["Dependency"]
    CM["Comment"]
  end
  subgraph RS["Runtime store (local sqlite, always)"]
    RUN["Run"]
    ES["engine_state"]
  end
  RUN -- "ref (key only, no FK)" --> WU
```

Jira 模式下 ticket 在 Jira，Run 在本機，兩邊靠 key 互指。

## 部署形態

| | local | cloud |
|---|---|---|
| 怎麼跑 | npm CLI，一個 process | container image |
| agent 認證 | 沿用使用者已登入的 claude / codex CLI | API key |
| tracker | sqlite 或 Jira | 通常 Jira |
| 登入 | 預設不登入，只綁 127.0.0.1 | 設 auth，或放在反向代理後面 |
| 單 instance | 是 | 是（v1 不做多 instance） |

## 暫定技術棧

最後才確認，目前傾向：

- 語言：TypeScript，Node。
- engine：單一 monolith process，同時 serve REST、MCP、靜態前端。
- 前端：Vue 3 + Vite SPA，打包成靜態檔由 engine serve。不用 Nuxt，因為是 API 後面的管理介面，不需要 SSR。
- repo：pnpm workspace。
- 工具鏈：Vite+（`vp`），lint、format、type check、測試、build 都走它，見 D27、D28。library 用 `vp pack`（tsdown）打包。

```
packages/
  core/       domain + application (ports live here), no I/O
  adapters/   storage-sqlite, storage-jira-cloud, runtime-sqlite,
              runner-claude-cli, runner-codex-cli, auth-none, auth-static, auth-http
  server/     composition root, REST, MCP facade, Poller, config loading
  web/        Vue 3 + Vite SPA
  cli/        init, doctor, start
```

sqlite driver（`better-sqlite3` 或內建的 `node:sqlite`）待選，見 plan.md 待驗證。
