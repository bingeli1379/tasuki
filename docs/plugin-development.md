# 寫一個 plugin

狀態：已確認（D96）。寫給要做第三方 tracker、store、runner、auth 的人。為什麼這樣設計看 plugins.md，這份只講怎麼做。能直接照抄的例子是 `examples/tracker-memory/`，一個存在記憶體裡的 tracker。

## 套件

- 名字取 `tasuki-plugin-<名字>`，有 scope 就是 `@<scope>/tasuki-plugin-<名字>`。`@tasuki/` 留給內建的。
- ESM（`"type": "module"`），default export 是 `@tasuki/core` 的 `definePlugin(...)`。engine 用 `import()` 載入，所以發佈的檔案要是 Node 直接跑得動的 JavaScript：`tsc` 輸出的話相對 import 寫 `.js` 副檔名（`module: NodeNext`），或者用 bundler 打包。
- `apiVersion` 寫 `1`。engine 要求完全相等，不相等就拒絕啟動。

依賴這樣寫：

| 套件 | 放哪 | 為什麼 |
|---|---|---|
| `@tasuki/core` | `peerDependencies`，另外放一份在 `devDependencies` 給自己的測試 | engine 用 `instanceof` 認 `StatusConflict`、`NotFound` 這些錯誤。plugin 自己帶一份 core 的話，丟出來的 class 跟 engine 的不是同一個，衝突會被當成一般錯誤 |
| `@tasuki/testkit` | `devDependencies` | 只有測試用 |
| `vitest` | `devDependencies` | testkit 的 peer，契約用它的 `describe`、`it` |

`@tasuki/core` 還在 0.x，版本寫確切的（例如 `0.0.0`）。testkit 依賴的也是同一個確切版本的 core，兩個一起升。

## 角色與工廠

```ts
export default definePlugin({
  name: 'tasuki-plugin-memory',
  apiVersion: 1,
  tracker: (ctx, options) => createMemoryTracker(ctx, readOptions(options)),
})
```

- 有提供的角色才寫那個 key：`tracker`、`store`、`runner`、`auth`。一個套件可以提供好幾個。
- 工廠拿到 `ctx`（`clock`、`configDir`、`dataDir`、`statuses`，auth 多一個 `store`）跟 config 裡的 `options`。現在時間一律從 `ctx.clock` 拿，資料放在 `ctx.dataDir` 底下，options 裡的相對路徑對 `ctx.configDir` 解析。
- `options` 是 config 原封不動交過來的（`${VAR}` 已經展開），engine 不驗。在工廠裡自己檢查，不對就丟 `Error`，訊息寫是哪個欄位，例如 `options.refPrefix must be ...`。engine 會在前面加上 plugin 名字，然後拒絕啟動。
- tracker：port 進出的 status 一律是邏輯名（`refining`、`to-do`）。存進 tracker 之前用 `ctx.statuses.toTracker(kind, status)` 翻成自己的 key，讀回來用 `fromTracker` 翻回去。
- 要讓 Tracker 頁畫得出表單，加上 `forms: { tracker: { fields, choices } }`（D111，欄位見 plugins.md）。標成 `secret` 的欄位由 engine 加密，plugin 拿到的是明文。
- 選用的方法沒有就不寫：`listStatuses`（tracker 有固定的 status 清單時）、`doctor`（只有 plugin 查得到的問題）、`readHeartbeat` / `writeHeartbeat`（不只一個 process 能打開同一個 project 時，用來擋第二個 engine）。每個方法的細節看 `@tasuki/core` 的型別註解。

## 契約測試

內建的 plugin 跟第三方跑的是同一套。fixture 自己建 plugin 的實例，要對照好下面這些 status：item 的 `refining`、`ready-to-split`、`in-progress`，task 的 `to-do`、`in-progress`、`manual`。

```ts
import { createStatusMap, DEFAULT_WORKFLOW, TASK_STATUS_DISPLAY } from '@tasuki/core'
import { describeTrackerContract } from '@tasuki/testkit'

const ctx = {
  clock: { now: () => new Date() },
  configDir: '',
  dataDir: '',
  statuses: createStatusMap({
    item: Object.fromEntries(DEFAULT_WORKFLOW.statuses.map((s) => [s.id, s.name])),
    task: TASK_STATUS_DISPLAY,
  }),
}

describeTrackerContract('memory', async () => ({ tracker: await plugin.tracker!(ctx, {}) }))
```

- `describeTrackerContract(name, setup)`：setup 回傳 `{ tracker, teardown? }`。tracker 裡本來就有別的資料沒關係，契約只看它自己建的東西。`list` 可以比寫入慢幾秒（Jira 從搜尋索引讀），契約會等它；`get`、`children`、`dependencies` 要馬上讀得到。
- `describeStoreContract(name, setup)`：setup 會拿到契約控制的 `Clock`，每條測試回傳一個空的 `{ store, teardown? }`。
- runner 與 auth 還沒有契約。

## 接上 engine

把套件裝在 config 所在資料夾的專案裡，engine 從那個資料夾解析套件名：

```jsonc
"tracker": { "plugin": "tasuki-plugin-memory", "options": { "refPrefix": "MEM" } }
```

先跑 `doctor`。套件找不到、export 形狀不對、`apiVersion` 不同、工廠丟錯，都會在這一步列出來。

## 這個 repo 怎麼驗範例

`pnpm verify:plugin-example`：build 全部，把 `@tasuki/core` 與 `@tasuki/testkit` 用 `pnpm pack` 打成 tarball，把範例複製到 workspace 外面的暫存資料夾，用 npm 從 tarball 安裝，再跑型別檢查、契約、build，最後 import build 出來的 plugin。要連網路裝 `vitest` 與 `typescript`，所以不在 CI 裡。改了 `core` 的公開型別、testkit 的契約或範例之後跑一次。
