# Decisions

持續更新。做了新決定或推翻舊決定，就在這裡加一條或修改，並更新對應的文件。
格式：決定、理由、什麼情況下要重新檢視。

## D1 tracker 二選一，不同步
- 決定：sqlite 與 Jira 擇一，選哪個就只看哪個，資料不同步。預設 sqlite，給了 Jira 的設定才用 Jira。
- 理由：同步兩邊的衝突處理成本遠大於價值。目標是沒有 Jira 也能在本機跑。
- 重新檢視：有人要求在 sqlite 與 Jira 之間匯入匯出時。

## D2 runtime store 永遠是本機 sqlite
- 決定：Run、engine_state 放本機 sqlite，Jira 模式也一樣。
- 理由：Jira 沒有地方放 lease、attempt、session、log。
- 重新檢視：要做多 instance 時。

## D3 engine 自己當 MCP server，agent 不拿 tracker token
- 決定：agent 寫回內容走 engine 提供的 MCP（中性 tool 名稱），status 轉移只有 engine 能做。
- 理由：直接掛 Jira MCP 有三個問題，sqlite 模式用不了同一份 prompt、agent 拿到整把 Jira 權限、agent 與 engine 會搶著改 status。
- 備案：engine 讀 agent 吐出的 JSON 再寫入（最簡單，但長 session 不能邊跑邊寫）。

## D4 ports and adapters，三個程式層級的擴充點
- 決定：Storage、Runner、Auth 是 port。stage 是 config，model 是 agent 的參數，前端是 API 的 client。REST、MCP、Poller 並排為驅動端，共用同一層 use case。
- 理由：規則只存在一處，換一邊不動另一邊，好測，好擴充。plugin 介面一開源就是承諾，所以不做「全部都是 plugin」。
- 重新檢視：真的有第四種需要抽換的東西出現時。

## D5 先做 M1，資料模型照 M2 設計
- 決定：task 是一等紀錄（有自己的 status），目前由每個 item 一個 orchestrator 自己排程。
- 理由：符合作者現在的工作方式，engine 小很多。以後升級 M2 只是多幾條 task 層規則，schema 不用動。
- 代價：依賴順序、平行度、task 層重試都在 LLM 手上，engine 管不到。

## D6 手動步驟就是預先建好的 manual task
- 決定：refine 階段把手動步驟建成 `manual` task（`origin=refine`），不另設欄位，也沒有 `mode` 欄位。
- 理由：Jira 上看得到，人也能直接改。

## D7 split-review 關卡
- 決定：多兩個 item status，`splitting` 與 `split-review`。AI 拆完 task 後等人檢查才放行。
- 理由：作者要先檢查 AI 開的 task。關卡只是兩條規則之間的 status，想略過的人改 `on.succeeded` 指向即可。

## D8 鎖用 Run 的 lease，status 只負責顯示
- 決定：防重複派發靠 lease 與 `one_live_run` 索引，claim status 是顯示用，可以省略。
- 理由：規則 B 的觸發 status 與執行中 status 同為 `in-progress`，只看 status 分不出在等還是在跑。lease 也同時解決當機復原。

## D9 停止的模型
- 決定：三種訊號（Stop 按鈕、`hold` label、把 status 移走），兩種強度（soft、hard），取消旗標加上 MCP 寫入被拒，寬限後才終止 process，另有全域 pause。
- 理由：人在 Jira 上的任何動作都能讓 AI 停，不需要 engine 專屬操作。
- 限制：M1 做不到單張 task 的 kill。

## D10 engine 只給 workspace，不管 git
- 決定：engine 建每張 item 的工作目錄並當 cwd，git 策略放在 skill。預設 branch 慣例是 `feature/<KEY>` 與 `task/<KEY>`，不巢狀，平行 task 用 worktree。
- 理由：git 策略因人而異。巢狀 branch 名在 git 裡會衝突。

## D11 session 是快取，item 內容才是記憶
- 決定：session 找不到或 resume 失敗就開新的。每次 Run 開頭 agent 先讀 item、task、comment 的現況。
- 理由：claude 與 codex 的 session 不互通，而且長 session 的 context 會膨脹。

## D12 Jira Cloud 優先
- 決定：先做 Jira Cloud adapter，Data Center 之後另寫一個，不是同一個加旗標。
- 理由：作者的公司用 Cloud。兩邊的認證方式與 description 格式不同。

## D13 前端用 Vue 3 + Vite SPA，由 engine serve
- 決定：不用 Nuxt。
- 理由：API 後面的管理介面不需要 SSR。靜態檔由 engine 一起 serve，一個 process 就能跑。

## D14 runner 預設 spawn headless CLI
- 決定：RunnerPort 的預設實作是 spawn `claude` / `codex` 的非互動模式。SDK 與 ACP 之後再看。
- 理由：最通用，直接沿用使用者已經裝好的登入、plugin、MCP。

## D15 auth 是 port，local 預設不登入
- 決定：`none` / `static` / `http` 三種，session ttl 可設，預設 24 小時。非 loopback 且沒有 auth 時拒絕啟動，除非 `allowInsecure`。
- 理由：見 security-and-auth.md 的威脅模型。作者曾問是否過嚴，保留，退一步是改成警告。
- 後續：三種 kind 與 24 小時的預設被 D89 改掉。

## D16 status 命名
- 決定：item 是 `refining`、`ready-to-split`、`splitting`、`needs-answers`、`split-review`、`in-progress`、`in-review`、`needs-rework`、`blocked`、`done`。task 是 `to-do`、`in-progress`、`in-review`、`manual`、`done`。
- 理由：名字描述球在誰手上，退回的都用 `Needs ...`，觸發 status 的名字直接講出 AI 下一步要做什麼。

## D17 只有 splitter 能建 task
- 決定：orchestrator 沒有 `create_task`。
- 理由：task 圖是人在 split-review 檢查過才放行的，放行後再讓 AI 加 task 等於繞過關卡。

## D18 rework 開新 task
- 決定：rework 由規則 C 把人的意見轉成新 task，舊 task 維持 `done`，新 task 也要先過 split-review。
- 理由：保留歷史，而且關卡本來就是檢查 AI 開的 task 的地方。

## D19 所有時間走可注入的 Clock
- 決定：不直接呼叫 `Date.now()`。
- 理由：lease 過期、session ttl 的測試不必實際等待。

## D20 自己寫 engine，不拿現成的當底
- 決定：自己寫。
- 理由：現成的 Sortie（Go，輪詢 issue 後 spawn agent）做的是「issue、agent、交接」一段式。這個專案需要多階段 SDD 流程、task 依賴圖、manual task 擋住 item、sqlite 本機模式與前端。
- 待辦：寫 storage adapter 之前先讀它的 adapter 介面與 SQLite schema。
- 重新檢視：讀完之後發現可以直接重用其中一塊時。

## D21 輪詢頻率
- 決定：sqlite 預設 5 秒，Jira Cloud 預設 30 秒，皆可設。webhook 是之後的驅動端。
- 理由：Jira 每條規則一條 JQL，頻率乘以規則數。API token 的流量不受新的 points 配額影響，但仍受 burst limit（待驗證，見 plan.md）。

## D22 文件的寫法
- 決定：mermaid 圖、單一術語表、一個決定一條紀錄、程式碼出現後 schema 以程式碼為準。
- 理由：文件要給人看，也要給 AI 看。

## D23 專案名稱 Tasuki
- 決定：叫 Tasuki（襷）。
- 理由：駅伝的接力帶，跑完一段交給下一個人，下一個可以是 agent 也可以是人，對應 status 之間的交接與人工放行。
- 注意：npm 上已有同名的 multi-agent 框架，發佈時要用 scope 或加後綴。GitHub 與網域尚未查。
- 重新檢視：發佈前查出撞名或商標問題時。

## D24 對外介面的識別字跟著專案名
- 決定：傳給 agent 的 env 前綴用 `TASUKI_`（`TASUKI_RUN_ID`、`TASUKI_TARGET`、`TASUKI_MODE`、`TASUKI_WORKSPACE`），config 的 schema 檔名是 `tasuki.config.schema.json`。
- 理由：D23 改名之前用的是 `SDD_` 與 `sdd.config.*`。這些會變成 agent prompt 與使用者 config 的一部分，發佈之後再改就是 breaking change。
- 注意：文件裡「SDD 流程」指的是 spec-driven development 這個方法，不是識別字，不用改。
- 重新檢視：D23 的名字因撞名而換掉時，這一條跟著換。

## D25 TypeScript 釘在 6.0.x（已被 D27 取代）
- 狀態：D27 換掉 typescript-eslint 之後，這個限制消失，TypeScript 改用 7.0.x。以下保留當時的理由。
- 決定：devDependency 的 `typescript` 用 `~6.0`，不用最新的 7.x。
- 理由：M0 安裝時 `typescript-eslint` 8.71.2 的 peer 只支援到 TS 6.1 以下，7.0.2 會 unmet peer。
- 原因：TS 7 是 Go 重寫的原生編譯器，7.0 沒有 JS API，typescript-eslint 靠那組 API 取型別。官方預告 7.1 會出新的、不同的 API。typescript-eslint 的 maintainer 在 issue #12518 說在 TS 7 有 API 之前無能為力，該 issue 已以 not planned 關閉。實驗中的支援在 PR #12803（draft，opt-in 的 native backend），作者實測大專案最多慢約 1.5 倍。
- 備案：並排跑，`typescript` 別名指向 `@typescript/typescript6`（給 lint 工具），另一個別名指向 `typescript@^7`（給 `tsc`）。官方公告有寫這個做法。目前專案小，`tsc` 速度沒有感，不值得多一層別名。
- 重新檢視：`typescript-eslint` 正式支援 TS 7.1 的 API 時，解除釘版本。專案大到 `tsc` build 時間明顯時，改走並排。

## D26 formatter 用 oxfmt，版本釘死（已併入 D27）
- 狀態：D27 之後 oxfmt 由 `vite-plus` 內建，設定搬進 `vite.config.ts`，版本跟著 `vite-plus` 釘死。以下保留當時的理由與風險。
- 決定：formatter 用 `oxfmt`，`devDependencies` 釘確切版本（不加 `^`），升版時手動升並看格式 diff。設定在 `.oxfmtrc.json`（`semi: false`、`singleQuote: true`），忽略 `docs/`、`CLAUDE.md`、`pnpm-lock.yaml`。lint 維持 ESLint 加 typescript-eslint。CI 跑 `format:check`。
- 理由：作者偏好。官方文件把它定位成 Prettier 相容流程的推薦選擇，速度快。
- 風險：版本還是 0.x，約每週一版（0.69 到 0.73 是 2026-09-21 到 2026-10-13），格式輸出可能隨版本變。預設 `printWidth` 是 100，不是 Prettier 的 80。不支援 Prettier plugin。
- 重新檢視：`oxfmt` 出 1.0 時改回 `^`。有格式輸出在升版時意外大改，就改回 Prettier。

## D27 工具鏈用 Vite+（VoidZero 整套）
- 決定：lint、format、type check、測試統一走 `vite-plus` 的 `vp`。`vp check` 一次跑 oxfmt、oxlint、tsgolint 的 type check，`vp test` 跑 Vitest。設定全部收在根目錄 `vite.config.ts`（`fmt`、`lint`、`test` 三個區塊）。移除 ESLint、typescript-eslint、單獨安裝的 oxlint、oxfmt、vitest。TypeScript 用 `~7.0.2`。
- 理由：作者要整套 Vite / Oxc 生態系。oxlint 的 type-aware 靠 `typescript-go`，要 TS 7 以上，剛好繞開 D25 的卡點。原本 ESLint 只開 recommended，沒有用到 type-aware 規則，換過去沒有功能損失。
- 釘版本：`vite-plus` 釘確切版本（`1.6.0`），`pnpm-workspace.yaml` 的 `overrides` 要寫同一個版本，`vitest` override 要等於 `vp toolchain vitest` 顯示的版本。升級時三處一起改。官方文件提到相依性機器人只升其中一個會造成不相容。
- 寫測試：從 `vite-plus/test` import，不從 `vitest` import。
- 已知現象：`vite` 被 override 成 `@voidzero-dev/vite-plus-core`，pnpm 拿它的版本號 1.6.0 去比對 vitest 要求的 `^6.4 || ^7 || ^8`，報 unmet peer。實際打包的 vite 是 8.3.7，不是執行期不相容。維護者在 `voidzero-dev/vite-plus` 的 #1021 與 #2806 說目前只能用 `peerDependencyRules.allowAny`，根本解法是把 core 的版本號對齊 Vite 的 major，#2806 還開著。
- 處理：`pnpm-workspace.yaml` 加 `peerDependencyRules.allowAny: [vite]`。官方建議的清單是 `vite` 與 `vitest`，我們只有 `vite` 會報，所以只放它，`vitest` 真有 peer 問題還是看得到。代價是之後若裝了不支援 Vite 8 的 Vite plugin，這條規則會一併遮掉。
- 重新檢視：#2806 修好後移除 `allowAny`。
- 風險：oxfmt 還是 0.x，格式輸出可能隨版本變（見 D26），因為版本由 `vite-plus` 釘死，升級是手動、可預期的。type-aware lint 在很大的 codebase 可能吃很多記憶體（官方文件的說明）。
- 重新檢視：專案大到 `vp check` 變慢或吃記憶體時。需要 ESLint 才有的規則時，可以並排跑兩者，官方文件有寫做法。

## D28 build 用 tsdown（`vp pack`），型別宣告走 isolatedDeclarations
- 決定：每個 package 的 `build` script 是 `vp pack`，不放設定檔，吃 tsdown 預設值（入口 `src/index.ts`、esm、`package.json` 有 `types` 或 `exports.types` 就產 dts）。根目錄 `build` 是 `vp run -r build`，依 package 相依順序跑。輸出是 `dist/index.mjs` 與 `dist/index.d.mts`，`exports` 照這個寫。
- 理由：作者要整套 Vite / Oxc 生態系，不要留一塊之後再換。
- `tsconfig.base.json` 開 `isolatedDeclarations: true`，並設 `noEmit: true`，移除 `composite`、`sourceMap` 與 project references，tsc 不再負責 build。原因是沒開的話 tsdown 會用 TS 的 API 產型別，而 TS 7 沒有穩定 API，tsdown 會警告實驗性。開了之後走 oxc-transform，不依賴 TS API。
- 代價：每個 export 都要有明確型別，例如函式要寫回傳型別，違規報 TS9007。
- 例外：根目錄 `tsconfig.json` 只管 `vite.config.ts`，把 `isolatedDeclarations` 關掉。設定檔不產生型別宣告，開著會讓編輯器對 `export default defineConfig(...)` 報 TS9037。
- 已驗證：這條只有 build（`vp pack`）會擋，`vp check` 不會。CI 的順序是 build 在 check 前面所以攔得到，本機只跑 `pnpm check` 會漏。
- 原因：`tsc --noEmit` 會回報 isolatedDeclarations 類的錯，tsgolint 目前不回報 declaration diagnostics。`oxc-project/tsgolint` 的 PR #1270（report global and declaration diagnostics，2026-10-10 開，未 merge）在補這塊。PR 內文沒有明講 TS9007，說它屬於 declaration diagnostics 是我的推斷，沒驗證。
- 快取：`vite.config.ts` 開了 `run.cache.scripts: true`，`build` 會被 Vite Task 快取。實測冷啟動約 1.3 秒，全部命中約 0.4 秒。改 source 只讓有改動的 package 失效，刪掉 `dist` 後命中會把產物還原。快取放在 `node_modules/.vite/task-cache`，只有 `vp run` 跑的 script 會被快取，`vp check`、`vp test` 不會。
- 快取的注意事項：正確性靠檔案系統自動追蹤，環境變數預設不進 fingerprint（只放行 `PATH`、`HOME`、`CI` 這幾個），`adapters` 之後開始 import `core` 時要重測一次失效是否正確。CI 每次是空的環境，不加 Actions 快取步驟就不會有命中，沒有壞處也沒有好處，build 變慢再加（做法見 vite-plus 的 `guide/github-actions-cache`）。
- 注意：`vp check` 的 type-aware 檢查，跨 package 的型別要先 build 才有 `.d.mts` 可讀（官方文件的限制）。目前 package 之間還沒有互相 import，之後有了要記得先 build。
- 重新檢視：isolatedDeclarations 的限制讓寫 domain 型別很痛時，改回讓 tsdown 走 TS 7 的路徑，前提是它脫離實驗性。

## D29 lease 過期的 item 回到該規則的 watch status
- 決定：claim status 上的 Run lease 過期時，item 送回「該 Run 那條規則的 watch status」，不是固定回 `ready-to-split`。規則 A 回 `ready-to-split`，規則 C（rework）回 `ready-to-rework`，`attempt + 1`，達到 `maxAttempts`（預設 3）就走該規則 `on.max_attempts` 的出口。
- 理由：`stop-and-recovery.md` 本來就是這樣寫，`state-machine.md` 的圖把兩條規則畫成同一個出口，是圖寫錯。rework 若回 `ready-to-split` 會被規則 A 撿走，用 split 模式重拆，丟掉 rework 的脈絡。
- 重新檢視：新增第四條會 claim 同一個 status 的規則時。

## D30 split 的 verdict 檢查不管 task 是誰建的，冪等由 agent 負責
- 決定：`succeeded (split)` 維持「item 底下至少有一個 task」，不改成只看這次 Run 的 `produced.tasks`。有沒有拆過，由 agent 讀 item 裡既有的 task 與 comment 記錄自己判斷，engine 不介入。
- 理由：作者決定。拆過的紀錄本來就留在 item 上，agent 讀得到，engine 再算一次是重複判斷。rework 因為一定要產生新 task，才用 `produced.tasks` 檢查，兩者目的不同。
- 風險：refine 階段已有 manual task 時，splitter 什麼都沒建也會過關。擋這個要靠預設 prompt 寫清楚，以及 `split-review` 的人工關卡。
- 重新檢視：實際跑起來出現 splitter 空手而回卻通過的案例時。

## D31 rework 的 needs_input 去 blocked，不去 needs-answers
- 決定：預設規則 C（rework）的 `on.needs_input` 是 `blocked`。規則 A（split）的 `needs_input` 維持 `needs-answers`。
- 理由：`needs-answers` 的出口是人答完拉回 `ready-to-split`，會被規則 A 撿走，用 split 模式重跑，丟掉 rework 的脈絡。`blocked` 的出口不限於 `in-progress`（見 state-machine.md），人補完資料可以直接拉回 `ready-to-rework`。
- 重新檢視：要讓 rework 也有專用的「等人回答」狀態時，新增 status 與對應規則，不要重用 `needs-answers`。

## D32 `needs-rework` 改名 `ready-to-rework`
- 決定：item 的 status `needs-rework` 改成 `ready-to-rework`，顯示名 `Ready to Rework`。`needs-answers` 不動。
- 理由：`ready-to-X` 一律代表排隊等 AI（`ready-to-split`、`ready-to-rework`），`needs-answers` 是等人。原本 `needs-rework` 與 `needs-answers` 共用前綴卻是相反的等待對象，光看名字分不出輪到誰。程式碼還沒出現，改名成本只有文件。
- 注意：D16 當初列出的狀態清單保留原樣，是歷史紀錄，以這一條為準。
- 重新檢視：再新增狀態時沿用這個前綴規則。

## D33 rework 先共用 `splitting` 當 claim status
- 決定：規則 C（rework）的 `claim` 維持 `splitting`，與規則 A 共用，不新增 `reworking`。
- 理由：畫面上 `splitting` 只代表「AI 處理中」，多一個狀態要在 Jira workflow 多設一個 status，換不到實質好處。
- 否決的做法：重做直接回 `in-progress`。`done` 的 task 不重開，重做要新 task，而 orchestrator 不能建 task，所有 task 都 done 時它會直接回報成功。要走這條只能放寬 orchestrator 的權限（繞過 `split-review`）或由人自己寫新 task。
- 備案：規則 C 省略 `claim`，像規則 B 靠 lease 防重複，代價是重做期間 item 停在 `ready-to-rework`，畫面看不出處理中。
- 重新檢視：使用者分不清 `splitting` 裡跑的是拆解還是重做時，改成 `reworking` 或省略 `claim`。

## D34 Run 記 `lastActivityAt`，並提供預設關閉的 `idleTimeoutMinutes`
- 決定：Run 新增 `lastActivityAt`，CLI 有輸出或 agent 呼叫 MCP tool 都更新它，隨 `renewLease` 一起寫入。UI 顯示「已跑多久、多久前有動作」。`limits.idleTimeoutMinutes` 預設 `null`（關閉），開啟時超過就照 `runTimeoutMinutes` 的方式處理（`failed`、hard stop）。
- 理由：headless 模式沒有管道中途詢問 agent，只能被動觀察。lease 只證明 process 活著，agent 卡死但 process 沒死時，會一直續約到 `runTimeoutMinutes` 才被砍。前台多一個一眼看得懂的指標，後台只多一個欄位，沒有新的 port 方法。
- 預設關閉：長時間工具呼叫期間 CLI 可能沒有輸出，開著會誤殺。CLI 的實際行為在 plan.md 待驗證，M3 驗完再定預設值。
- 順帶決定：`runTimeoutMinutes` 全域維持 60，預設規則 B（execute）覆寫成 `timeoutMinutes: 480`，因為一個 orchestrator 要跑完整張 item，作者實測通常要好幾個小時。`limits` 補上 `softGraceSeconds`（300）與 `hardGraceSeconds`（10）。
- 重新檢視：M3 驗證完 CLI 輸出行為時。

## D35 agent 的 `allowedTools` 預設全擋，憑證只走 `env`
- 決定：`allowedTools` 空陣列或省略，代表只有 runner 注入的 tasuki MCP tool 可用，其餘一律不准。`auth` 只宣告方式（`inherit-login` / `api-key` / `oauth-token`），憑證一律放 `env`，不開專用欄位。`auth` 省略時是 `inherit-login`，`codex-main` 範例補上同一個欄位。
- 理由：headless 沒有人能即時按允許，預設放行等於權限過大，預設全擋最多是 agent 做不了事，`doctor` 會警告。憑證只走 `env` 一條路，config 不用為每種 CLI 各開一個 key 欄位，也跟「`env` 只給被 spawn 的 CLI」的既有規則一致。
- 後果：只靠預設值的 agent 沒辦法改檔，`init` 產生的 config 一定要帶預設清單，這是 M3 的待辦。
- 待驗證：兩個 CLI 認證各吃哪個環境變數、`allowedTools` 的名稱格式（見 plan.md）。
- 重新檢視：M3 驗完 CLI 行為時。

## D36 rule 不放 `kind` 欄位
- 決定：移除 rule 的 `kind` 欄位。規則一律作用在 item，`watch`、`claim`、`on` 的目標都是 `statuses.item` 裡的 status。
- 理由：只有 `item` 一個值，是為未來預留的欄位，沒有第二個值就沒有判斷意義。task 層的規則（M2 的依賴圖排程）真的要做時再加，那時才知道欄位該長什麼樣子。
- 重新檢視：要做 task 層規則時。

## D37 rule 欄位收斂：拿掉 `role`、補預設值、prompt 不放 ticket 內容
- 決定：
  1. 移除 rule 的 `role`，MCP 權限角色由 `mode` 決定（`split`、`rework` 是 splitter，`execute` 是 orchestrator）。
  2. `prompt` / `promptFile` 省略時用引擎內建、對應 `mode` 的預設 prompt，兩個同時設報錯（`doctor` 第 11 條）。
  3. `on.failed` 與 `on.max_attempts` 省略時是 `blocked`，其餘 outcome 仍要明確設定。
  4. prompt 範本變數拿掉 `{{item.title}}`，只留 `{{item.ref}}`、`{{run.id}}`、`{{workspace}}`、`{{mode}}`。
- 理由：`role` 與 `mode` 永遠一起動，多一個欄位只會多一條防止不一致的驗證。三條預設規則本來就沒寫 prompt，省略時的行為不寫清楚就沒有定義。`stop-and-recovery.md` 本來就說 `max_attempts` 預設 `blocked`，`failed` 一併給預設，使用者少寫兩行，後台只多一個預設值。標題也是使用者寫的內容，放進 prompt 與「ticket 內容不進 prompt」的原則矛盾。
- 例外：預設規則的範例仍把 `failed`、`max_attempts` 寫明，方便讀。
- 重新檢視：出現「同一個 mode 要搭不同權限」的需求時，才把 `role` 加回來。內建預設 prompt 的內容在 M3 寫。

## D38 attempt 只在 abandoned 之後累計，max_attempts 也是一筆 Run
- 狀態：已確認（2026-11-20，S4 實作，見 D63）。
- 決定：新 Run 的 `attempt` 是上一次 Run（同一張 item、同一條 rule）若為 `abandoned` 就加 1，否則回到 1。要開的 attempt 超過 `maxAttempts` 時，engine 不起 agent，而是建立一筆 outcome 為 `max_attempts` 的 Run，item 走該規則 `on.max_attempts` 的出口，並寫一則 `system` comment。
- 理由：文件只明講 `abandoned` 之後 `attempt + 1`，而 `stop-and-recovery.md` 又說人在 loop 裡的來回不設上限，所以 `succeeded`、`needs_input`、`failed`、`cancelled` 之後都不該累計。把 `max_attempts` 記成一筆 Run，item 被人拉回去之後，上一筆是 `max_attempts` 就從 1 重算，等於「人手動拉回就歸零」，不用觀察人的移動。
- 作者的意圖是「人只要介入拉來拉去就重算」，這條在實務上等於做到了：人會介入的時機，item 都停在 `blocked`、`needs-answers`、`split-review` 這類出口，上一筆 Run 不是 `abandoned`，拉回去自然從 1 開始，engine 不用觀察是誰移動的。
- 已知限制：Run 死掉、engine 剛把 item 送回 watch status，人在下一輪 Poller 之前把它拖走又拖回來，這時還是接著累計。要蓋到這個角落，engine 得分辨人的移動；Jira 上的人直接在 Jira 拖卡、不經過 tasuki，只能每輪讀 issue changelog，等於每張命中的 item 多一支 API，只記 tasuki 看板的移動又讓兩個 tracker 行為不同，所以不做。
- 重新檢視：出現 `failed` 要自動重試的需求，或需要 item 層累計成本上限時；那個角落真的被踩到時。

## D39 M1 實作時補的假設
- 狀態：程式碼隨 M1 一起丟掉（D41），這些假設保留，對應的切片寫到時逐條確認，不再整批沿用。
這些文件沒寫，M1 為了能寫程式先這樣定，等作者確認。

- 十個 item status 與五個 task status 的邏輯名固定，`statuses.item` / `statuses.task` 必須全部有對照，可以多不能少。自動接回、復原用到的 `blocked`、`in-progress` 等名字寫死在程式裡。
- `blocked_manual` 只有 execute 能用。split / rework 回報它一律當 `failed`，因為這兩種規則沒有對應的出口。
- Run 逾時（`timeout: 'run'`）或沒動靜（`'idle'`）一律是 `failed`；非零 exit code 或被 signal 終止也是 `failed`，即使 agent 已經回報 `succeeded`。人按了 Stop 或貼了 `hold`（`cancelRequestedAt` 有值）則是 `cancelled`，優先於上述所有情況。
- 結果轉移遇到 `StatusConflict`（人在 Run 中動過 item）時，Run 的 outcome 改記 `cancelled`，status 不動，但 agent 的 summary 照樣寫成 `system` comment。
- `logPath` 由 runtime store 決定，use case 不傳。
- 自動接回的條件 2 解讀為「item 底下沒有任何 status 是 `manual` 的 task」。
- task 移動：人只有圖上的四條（`to-do`/`in-progress` → `manual`、`manual` → `done`/`to-do`），agent 與 engine 各自的邊見 `task-machine.ts`。`done` 對所有人都是終點。
- doctor 第 10 條只能檢查 `env` 非空，因為各 CLI 要吃哪個變數還沒驗證。

## D40 core 的內部分層：domain、application，檔案依概念命名
- 狀態：當時那套目錄已隨 M1 丟掉（D41）。分層規則與命名原則保留，目錄隨切片長出來。
- 決定：`core/src` 分 `domain/` 與 `application/`。`domain/` 只放業務概念與規則（`work-unit.ts`、`run.ts`、`rule.ts`、`verdict.ts`、`task-machine.ts`、`status.ts`、`actor.ts`），不 import `application`。`application/` 分 `ports/`（Storage、RuntimeStore、Clock 與 adapter 會丟的錯誤）、`use-cases/`（一個檔案一個 use case）、`config/`（config 型別、預設規則、doctor 檢查）與 `deps.ts`。不用 `types.ts`、`utils.ts` 這類依技術分類的檔名。
- 理由：M1 第一版把所有型別塞進 `domain/types.ts`，又把 config 型別與預設規則放進 `domain/`，那些不是業務概念。層名維持 `domain`、`application`，因為專案文件、glossary 與後端慣用的 Domain / Application / Infrastructure / Api 都是這組，DDD 圈與 Clean Architecture 的對照文章也用這兩個名字。Clean Architecture 原文的 Entities / Use Cases 是同一層的另一種叫法，換過去只會多一套名詞。
- 參考：Cockburn 的 Hexagonal Architecture 原文（port 是「有目的的對話」，adapter 是技術相關的轉接，primary 是驅動應用的一側、secondary 是被應用驅動的一側）、Robert Martin 的 The Clean Architecture（依賴只能往內，跨界線傳簡單的資料結構）、Khalil Stemmler 的 DDD vs Clean Architecture（Domain 與 Application 兩層的對照，範例用 `domain/job.ts`、`useCases/` 這種依概念命名的路徑）。
- 取捨：`Config` 型別現在整包放在 `application/config/`，包含 `server`、`agents`、`tracker` 這些只有 adapter 或 server 會用的欄位，core 其實不需要知道。等 `server`、`cli`、`adapters` 實際有程式碼了再拆，現在拆會變成為還不存在的套件預留結構。doctor 的第 7、10 條檢查跟著那些欄位走，到時一起搬。
- 重新檢視：`server` 或 `cli` 套件開始寫、需要 import config 型別時。

## D41 改成垂直切片，M1 水平切層的 code 整個丟掉
- 決定：開發改成一次一個功能，從畫面一路做到 DB（web、REST、use case、port、sqlite），做完作者能在瀏覽器操作再做下一個。原本 M1 先寫完 core 的 domain、use case 與假 adapter，那批 code（約 1200 行加 1000 行測試）全部刪除，`plan.md` 的里程碑換成切片清單。
- 理由：作者只看得到零件，看不到流程，所以看不懂。水平切層要等整層寫完才有東西能操作，回饋太晚，而且 core 的每個型別、每條規則都是在沒有使用情境下預先寫的。垂直切片讓每個型別與規則都有一條從畫面進來的路徑可以解釋。
- 代價：M1 的 130 個測試與六條不變量的對照表要在後面的切片裡重寫。刪除前備份在 scratchpad，只是保險，不進 repo。
- 保留的：分層規則與命名原則（D40）、各項設計假設（D38、D39）、所有設計文件。
- 重新檢視：切片之間出現大量重複的接線，或同一個規則被不同切片各寫一遍時。

## D42 技術選型：node:sqlite、Hono、Vue 3 SPA、append-only migration
- 決定：sqlite 用 Node 內建的 `node:sqlite`（Node 24.22 實測可用，sqlite 3.53.4），不裝 `better-sqlite3`。server 用 Hono 加 `@hono/node-server`。web 是 Vue 3 加 `@vitejs/plugin-vue`，開發時 Vite 把 `/api` proxy 到 `127.0.0.1:8787`。schema 用 append-only 的 SQL 字串陣列當 migration，已執行的數量記在 `PRAGMA user_version`，每個 migration 在一個 transaction 裡，失敗就 rollback。
- 理由：`node:sqlite` 不用多一個要編譯 native 模組的相依，符合「內建能做就不裝套件」。Hono 小、型別好、`app.request()` 可以直接在測試裡呼叫，不用真的開 port。migration 用 `user_version` 不用另外建 migrations 表，目前只有線性往前，夠用。
- 風險：`node:sqlite` 在較舊的 Node 上是實驗性 API，所以 `engines` 釘 `>=24`。web 目前沒有 `.vue` 的型別檢查（`vp check` 看不懂 SFC），先靠 `env.d.ts` 的 shim 通過，之後要不要加 `vue-tsc` 再決定。config 載入還沒做，port 與資料目錄先吃環境變數 `TASUKI_PORT`、`TASUKI_DATA_DIR`（DB 是其下的 `runtime.db`），S1 改讀 config。
- 重新檢視：要在 Node 24 以前的版本跑時，或 migration 需要分支與回退時。

## D43 module resolution 用 Bundler，相對 import 不寫副檔名
- 決定：`tsconfig.base.json` 的 `module` 是 `ESNext`、`moduleResolution` 是 `Bundler`，相對路徑 import 一律不寫副檔名（`from './app'`）。`web` 原本就是這樣，現在跟其他套件一致，它的 tsconfig 不用再各自覆寫。
- 理由：原本的 `NodeNext` 要求寫編譯後的副檔名（`./app.js` 指向 `app.ts`），看起來怪，寫錯才會在 build 時報。`server`、`adapters`、`core` 都由 tsdown 打包後才執行，沒有人會把原始 `.ts` 直接交給 Node，`NodeNext` 的嚴格換不到保證。前台少一個要思考的副檔名，後台沒有多代價。
- 風險：`tsc` 不再保證「原始碼直接給 Node 跑得起來」。如果之後有套件要不經打包直接發佈或執行（例如給 `node --experimental-strip-types` 跑），要把那個套件改回 `NodeNext`。
- 重新檢視：出現不經打包就執行的 `.ts` 時。

## D44 plugin 是一等公民：in-process npm 套件，三個角色，一個技術一個套件
- 決定：tracker、runner、auth 三個角色都可以由第三方寫成 npm 套件，內建的 sqlite、Jira Cloud、claude-cli、codex-cli 與第三方走同一條載入路徑。plugin 與 engine 同一個 process。RuntimeStore 不開放，放在 `server`。套件按技術切（`sqlite`、`jira-cloud`、`claude-cli`、`codex-cli`），不按角色切。`core` 是公開契約，另有 `testkit` 放契約測試。plugin 宣告 `apiVersion`。細節見 plugins.md。
- 理由：作者確定一定會支援第三方，而且已經知道最終的形狀，一開始就做成那個形狀。內建的如果跟第三方長得不一樣，內建的就會偷用內部細節，第三方寫不出同等的東西。in-process 讓型別直接共用，是 Vite、ESLint 這類 plugin 的做法。RuntimeStore 是 engine 自己的狀態，開放它就得要求每個實作撐得住 lease 的原子操作。
- 後果：ports 與它們引用的型別變成公開 API，改簽名是 breaking change。`@tasuki/adapters` 已改名 `@tasuki/sqlite`。Jira 模式下 `sqlite` 套件不是必裝，runtime store 的 sqlite 程式碼在 `server` 裡另有一份開 DB 加 migration 的小程式（約 35 行），接受重複，因為兩顆 DB 的 schema 各走各的。
- 風險：plugin 能讀到環境變數與檔案系統，沒有沙箱（security-and-auth.md）。形狀的細節還有九項待定（plugins.md）。
- 取代：`plan.md` 原本把「plugin 載入機制」列在 v1 不做，這一條推翻它。
- 重新檢視：需要執行不受信任的 plugin 時，才考慮獨立 process 加協定。

## D45 文件描述整體設計，不分版本，實作順序只看切片
- 決定：文件不再用 v1、v2 區分。`plan.md` 的範圍描述整個產品，實作順序只看切片清單。原本的 Non-goals 拆成「刻意不做」（只有 engine 不內建 git）與「還沒決定要不要做」（多 instance、RBAC、sqlite 模式的使用者系統、Jira Data Center、webhook）。M2（engine 依賴圖排程）排進切片 S13。
- 理由：作者已經知道要做的東西，用版本切會把本來一定要做的事（plugin）說成之後再說，形狀也就做不對。切片已經承擔「先做什麼」的職責，不需要再用版本表達同一件事。
- 同時改的：`glossary.md`、`architecture.md`、`config-and-rules.md`、`security-and-auth.md` 與幾條舊 decisions 裡的 v1 字眼。決定本身沒變，只拿掉版本說法。
- 重新檢視：出現真的要對外發版、需要相容性承諾的時候。

## D46 路徑相對於 config 檔，一個 `dataDir` 收所有狀態
- 決定：config 檔一定要有，config 裡的相對路徑都相對於 config 檔所在的資料夾。新增 `dataDir`（預設 `./data`），tracker DB、runtime DB、Run log、`workspace.root` 的預設值都從它底下長出來。`tracker.sqlite.path` 拿掉，sqlite 檔案固定在 `<dataDir>/tracker.db`。啟動時印出解析後的絕對路徑。
- 理由：原本相對路徑是相對於 process 的工作目錄，換個地方啟動就會在別處多出一顆 DB，而 `.gitignore` 的 `data/` 會把它遮住。文件也沒有定 runtime DB 與 Run log 放哪裡。一個資料夾一個 instance，要備份或搬家整包帶走。前台只要記一個位置，後台只多一個把相對路徑對到 config 資料夾的小函式。
- 取代：`config-and-rules.md` 原本的 `tracker.sqlite.path` 與 `workspace.root: ./workspaces`。
- 待定：config 檔名 `tasuki.config.jsonc` 沿用 D23 改名後的命名，沒有另外討論過。
- 重新檢視：出現多個 instance 想共用同一份 data 的需求時。

## D47 每個切片 sqlite 與 Jira Cloud 一起做、一起驗
- 決定：從 S1 開始，每個切片同時實作 `sqlite` 與 `jira-cloud` 兩個 tracker，用同一組 StoragePort 契約測試驗兩邊，作者在兩邊都能從瀏覽器操作才算做完。S10 只剩 `doctor`。use case 不能假設多次 StoragePort 呼叫是原子的，每一步中途失敗後都要能重跑。
- 理由：作者擔心做到後面才發現 Jira 的形狀跟 sqlite 不同，要整個打掉。設計本來就以 Jira 的限制為準（`ref` 不透明、status 用邏輯名、Run 放本機、轉移用 compare-and-set），整個打掉的機率低，真正會分岔的是幾個簽名與行為：多步寫入的原子性、寫入後搜尋的延遲、看板一次讀多個 status 的成本、comment 的 author / kind、markdown 與 ADF 的互轉。只做 sqlite，port 會被 sqlite 的形狀養歪，這些到 S10 才一起爆。每個切片兩邊都做，分岔在當下就看得到。
- 代價：每個切片的工作量變多；`plan.md` 待驗證裡 Jira 的項目提前到 S1；需要一個可以隨意建 issue 的 Jira Cloud 測試 site 與 project。
- 取代：`plan.md` 原本「先把 sqlite 做到能完整跑，Jira adapter 放在 sqlite 的行為穩定之後」的順序。
- 重新檢視：Jira 的測試環境拖慢每個切片到不能接受，或某個切片的行為確定只屬於 sqlite 時。

## D48 plugin 的匯出形狀、config 寫法、載入失敗
- 決定：plugin 的 default export 是 `definePlugin({ name, apiVersion, tracker?, runner?, auth? })`，每個角色是工廠函式 `(ctx, options) => 實例`，`ctx` 帶 `Clock`、logger、`dataDir`。config 用 `{ "plugin": "<npm 套件名>", "options": {...} }` 指定，`options` 原封不動交給工廠。`statuses` 留在 config 最外層。任何載入失敗都拒絕啟動。
- 理由：engine 要在建立實例時注入 `Clock` 等東西，工廠的參數就是注入點，第三方不用繼承 `core` 的 class，和 Vite、ESLint 的 plugin 同一種形狀。`statuses` 是 engine 在讀的邏輯名對照，不是 tracker 私有的設定。少了 tracker 或 runner engine 無事可做，跳過只會讓人以為它在跑。
- 取代：`config-and-rules.md` 原本的 `tracker.kind` 加 `tracker.jira`。plugins.md 待定的 1、2、8 結案。
- 重新檢視：plugin 需要在 engine 啟動後動態載入或卸載時。

## D49 本機的 secret 放 config 旁邊的 `.env`
- 決定：啟動時，config 檔所在資料夾有 `.env` 就用 Node 內建的 `process.loadEnvFile` 讀進環境變數，已經存在的環境變數優先。`.env` 列進 `.gitignore`。config 裡照舊只寫 `${VAR}`。
- 理由：文件定了 `${VAR}` 展開，但沒定變數從哪來。本機開發每次在 shell export token 很煩，`.env` 是大家預期的位置。Node 24 內建讀取，不用加 dotenv。container 與 CI 直接給環境變數，不受影響。
- 重新檢視：需要從 secret manager（Vault、1Password CLI）取值時。

## D50 Jira 的 issue type、status、link type 在 config 裡用 id
- 決定：`jira-cloud` 的 `issueTypes`、`dependencyLinkType` 與 `statuses` 對照的值寫 Jira 的 id，不寫名稱。link type 一開始寫成名稱 `Blocks`，比照 issue type 改成 id，KAN 上是 `10000`；link type 名稱會不會翻譯還沒驗過，改 id 是為了同一份 config 只有一種寫法。sqlite 照舊寫名稱，`statuses` 的值對 engine 是不透明的 tracker 端識別。id 由 `init` 向 Jira 查出來再寫進 config；S1 到 S11 先手寫。
- 理由：在測試 site（KAN，team-managed）上實測。名稱會依 token 擁有者的語言設定翻譯，而且不同 endpoint 給的不一樣：同一個 `10009`，`/project/{key}/statuses` 回 `Story`，`/issuetype/project` 回 `故事`，`Accept-Language` header 沒有作用。id 也不是全域固定的：team-managed 的 issue type scope 是 `PROJECT`，status 除了內建的 `3`（進行中）以外也是 `PROJECT`，換一個 project 就是另一組 id，所以不能寫死在預設值裡。
- 代價：config 裡的 id 人看不懂，`init` 寫入時要附上名稱當註解，UI 顯示的名稱向 Jira 取。
- 重新檢視：支援 company-managed project，或 Jira 提供不翻譯的穩定 key 時。

## D51 S1 實作時補的假設
- 狀態：暫行，等作者確認。文件沒寫，S1 為了能寫程式先這樣定。
- sqlite 的 ref 格式已由 D52 定案。
- 省略 `statuses` 時，每個邏輯名對到顯示名；`statuses.item` 一定要對照 `refining`，否則拒絕啟動。
- 看板只顯示 config 有對照的 item status，順序照 state-machine.md。S1 時 KAN 只對照 `refining`，只有一欄；S2 補齊了十個（D59）。
- plugin 從 config 所在的資料夾解析。本機開發的 config 在 repo 根目錄，所以根目錄的 `package.json` 把 `@tasuki/sqlite`、`@tasuki/jira-cloud` 列成 devDependencies。
- `apiVersion` 要求完全相等（plugins.md 待定 3）。
- Jira 的 body 先當純文字，一行一個 ADF paragraph，markdown 格式會掉。
- 建 Jira issue 之後，如果落在的初始 status 不是要的 status，再做一次轉移。兩次呼叫不是原子的（D47），轉移失敗時 issue 留在初始 status，錯誤照樣丟出來。
- `server.host` 先不讀，一律綁 `127.0.0.1`，等 S9 有 auth。
- 重新檢視：作者確認或推翻任何一項時，改這條並更新對應文件。

## D52 sqlite 的 ref 前綴由使用者在 config 設定
- 決定：sqlite 的 ref 是 `<refPrefix>-<n>`。`refPrefix` 放在 `@tasuki/sqlite` 的 `options`，預設 `TSK`，只能是大寫英文字母開頭的大寫字母與數字（跟 Jira 的 project key 同一種形狀），不合格就拒絕啟動。n 是流水號，和前綴無關，在同一個 INSERT 裡算出來，兩個同時建立也不會撞號。
- 理由：ref 是人每天在看板上看到的名字，前綴應該是使用者的專案名，不是 tasuki 的。只有 sqlite 需要前綴，Jira 的 key 由 Jira 決定，所以放 plugin 自己的 options，不放 config 最外層（D48）。限制成 key 的形狀，ref 之後放進 URL、filter 都不用跳脫。
- 改前綴：已經存在的 item 保留原本的 ref，新建的才用新前綴，流水號繼續往下數。不回頭改名，因為 runtime store 的 Run 用 ref 指向 item，改名會斷掉。
- 取代：D51 裡「sqlite 的 ref 是 `TSK-<n>`」那一項。
- 重新檢視：出現要把舊 item 一起改名的需求時。

## D53 .vue 的 template 型別檢查用 `@vue/content-mapper`，git hook 用 Vite+ 內建
- 狀態：型別檢查的部分已被 D58 取代，改用 vue-tsc 配 TS 6；git hook 的部分不變。以下保留當時的比較。
- 決定：`vp check` 只檢查 `<script>`，template 打錯欄位抓不到，所以 `web` 另外跑 `tsc --noEmit --runExternalCode`，靠 `tsconfig.json` 的 `contentMappers` 掛 `@vue/content-mapper`（Vue Language Tools v4）讀懂 `.vue`。根目錄的 `check` 是 `vp check` 加上 `vp run -r typecheck`，CI 與本機同一條。`typescript` 升到 `7.1.0-beta`，因為 `contentMappers` 是 7.1 才有；`@vue/content-mapper` 釘 `4.0.0-alpha.3`。`env.d.ts` 的 `*.vue` shim 留著，因為 `vp check` 的 tsgo 不跑 mapper，拿掉會找不到 `.vue`。
- git hook：`vp config` 裝 dispatcher（`prepare` script 會跑），`.vite-hooks/pre-commit` 跑 `vp staged`，對 staged 檔案做 `vp check --fix`。不裝 husky 與 lint-staged，`vp staged` 內建 lint-staged。
- 比較過的方案（都在 `web` 的副本上故意打錯 template 欄位實測）：
  - vue-tsc 3.3.14 配 TS 7.0.2：直接失敗，`ERR_PACKAGE_PATH_NOT_EXPORTED`，因為它要 patch TS 的 JS API，TS 7 沒有。
  - vue-tsc 3.3.14 配 TS 6（D25 的別名做法）：可用、穩定，但要多養一份 TS，之後還要再遷一次。
  - vue-tsgo 0.3.0：TS 7.0.2 就能用，第三方個人維護，官方版出來後多半沒人顧。
  - content-mapper：官方下一代，TS 與 mapper 都是預覽版，選它是因為正式版出來只要升版本。
- 風險：`typescript` 目前只有這條檢查會用到（`vp check` 用 Vite+ 自帶的 tsgo，`vp pack` 用 oxc），預覽版壞掉影響範圍只到這一步。編輯器的 Vue 擴充還是用它自帶的 TS，與 CI 的結果可能不一樣。
- 重新檢視：TS 7.1 與 Vue Language Tools v4 出正式版時改成 `^`；mapper 壞掉又一時修不好時，退回 vue-tsc 配 TS 6。

## D54 `StoragePort.list` 可以落後寫入
- 決定：`list` 不保證馬上看得到剛寫入的東西。剛寫完的呼叫端用寫入回傳的結果：看板新增後把 POST 回來的 item 直接放進欄位，不重新讀取。契約測試建完之後在 10 秒內重試 `list`。
- 理由：Jira 的搜尋索引有延遲。2026-11-16 在 KAN 實測，建完 338ms 搜不到、1740ms 搜得到；同時間 `key = X` 的 JQL 與 `GET /issue` 都馬上查得到。S1 的契約測試建完馬上搜，同一天連跑 3 次都失敗。
- 沒選的做法：讓 Jira adapter 記住剛寫入的 key，`list` 時補撈。轉 status 也有同樣的延遲，要記的東西會一路變多，換到的只是 `list` 看起來即時。
- 影響：Poller 可能晚一輪才看到 item 進入觸發 status，不影響正確性，因為認領走 `transition` 的 compare-and-set，讀的是 issue 本身。
- 重新檢視：出現「寫完馬上要 list 才正確」的 use case 時。
- 2026-11-20 補記：S5 檢查 split 的 verdict 要馬上看到 agent 剛建的 task，就是上面那種 use case。實測 `key in (...)` 加上 issuetype 條件的 JQL 也會漏掉剛建的 sub-task，所以「`key = X` 馬上查得到」不能推到搜尋上。`children` 與 `dependencies` 改用 `POST /issue/bulkfetch` 直接讀 issue（D65）。

## D55 測試分三層，每層擋一種壞法
- 決定：
  - 單元：domain 規則與 use case，不碰 I/O。狀態機的轉移與不變量照 CLAUDE.md 要一列一個測試。
  - 整合：tracker plugin 都跑 `testkit` 的 StoragePort 契約；server 用 `app.request` 測 API，另外測 plugin 載入的每種失敗。
  - E2E：Playwright，在 `packages/web/e2e`。每個切片一條主路徑，從瀏覽器操作到資料真的存進 tracker（重新整理還在）。sqlite 每次都跑，`.env` 有 `JIRA_*` 時加跑 Jira，測完刪掉建出來的 issue。
- 原則：寫能擋住功能壞掉的測試，不為覆蓋率寫。前端元件沒有自己的邏輯時不寫元件測試，E2E 已經蓋到；長出 composable 再測它。
- 理由：作者大量用 AI 改程式，要靠測試確定功能沒壞。三層各自抓不同的錯：單元抓規則寫錯，整合抓兩個 tracker 行為不一致與載入失敗，E2E 抓前後端接不起來。
- CI：build、check、test 之後裝 chromium 跑 `pnpm e2e`，CI 沒有 Jira 的 secret，只跑 sqlite。
- 重新檢視：E2E 跑太久，或某層一直抓不到真正的錯時。

## D56 前端元件用 Nuxt UI
- 決定：`web` 用 `@nuxt/ui`（v4，Reka UI 加 Tailwind 4），以 `@nuxt/ui/vite` 外掛在純 Vue + Vite 底下使用，`router: false`，不裝 vue-router。元件自動匯入，產生的 `components.d.ts`、`auto-imports.d.ts` 不進 git，`web` 的 tsconfig 把它們納入 template 型別檢查。
- 理由：之後要有 modal、下拉、toast、表單驗證，自己刻的話 focus 與鍵盤操作要自己顧。Nuxt UI 的 peer 支援 TS 7，不跟 D27、D53 的工具鏈衝突。
- 沒選的：
  - UI SDK（Vercel，2026-11-12 發表）：`@ui-sdk/vue` 還是 `0.1.0-beta.3`，而且只給行為不給樣式，畫面仍然要自己刻。
  - PrimeVue 很完整但很重；Vuetify 是 Material 外觀；Element Plus 適合後台但外觀偏舊。
- 安裝時的供應鏈設定：4.12.1 與 4.12.2 都在當天發布，被 pnpm 的 `minimumReleaseAge` 擋下。不加例外，改用 `^4.12.0` 讓 pnpm 選過了冷卻期的版本（目前鎖 4.12.0）。`esbuild` 與 `vue-demi` 的 build script 在 `allowBuilds` 設為不執行：esbuild 的平台 binary 由 optionalDependencies 裝好，vue-demi 預設就是 Vue 3。
- 已知限制：template 型別檢查抓得到不存在的 prop，但 Nuxt UI 的 variant 類 prop（例如 `size`）型別是放寬的，給錯值不會報錯。
- 重新檢視：UI SDK 出正式版且有預設樣式時，或 Nuxt UI 跟 TS、Vite+ 版本卡住時。

## D57 使用者的 AI client 用 engine 的 `/mcp` 操作 tasuki
- 決定：engine 在 `/mcp` 提供 MCP（Streamable HTTP，無狀態，每個請求開新的 server）。身分是使用者，能做的事跟看板一樣，背後呼叫同一個 use case，之後每個切片的人操作在看板與 `/mcp` 都要有。Claude Code 與 Codex 都要能接，用 http 設定 `http://127.0.0.1:<port>/mcp`。
- 能改 item status：使用者叫自己的 AI 改，跟自己點按鈕一樣，算「人」。「agent 不能改 item status」限制的是 engine 派出、沒人盯著的 agent，它們走另一個入口（MCP facade，帶 run token，D3）。代價是使用者的 AI 把 item 拉進觸發 status，就會真的開始派 agent。操作者記成使用者並標 `via mcp`，等有記錄操作者的切片時實作。
- 理由：sqlite 模式下 refine 階段的 AI 原本沒有地方寫回 tracker（待釐清 5）。Jira 模式雖然有 Atlassian MCP，但它不知道 tasuki 的 status 對照與規則，走 tasuki 才會過同一套驗證。
- tool 名稱是中性的，不帶 Jira 或 sqlite（CLAUDE.md）。
- 安全：與 REST 同一個威脅面，見 security-and-auth.md。
- 重新檢視：MCP facade（S8）做出來後，兩個入口的 tool 有大量重複時，看要不要共用定義。

## D58 template 型別檢查改用 vue-tsc 配 TS 6
- 決定：取代 D53 的型別檢查部分。`web` 的 `typecheck` 是 `vp build && vue-tsc --noEmit`，`vue-tsc` 釘 `3.3.14`，`web` 自己裝 `typescript@~6.0.3` 給它用；根目錄的 `typescript` 退回 `~7.0.2`，不再用 7.1 beta。`vp check` 用 Vite+ 自帶的 tsgo，不受 `web` 的 TS 6 影響。`web` 的 tsconfig 開 `vueCompilerOptions.strictTemplates`，元件不認識的 prop 與屬性會報錯。
- 理由：作者不要 `@vue/content-mapper`。查證（2026-11-17）：它在官方的 `vuejs/language-tools`，維護者與 vue-tsc 相同，最後一版是 11/01，但每週下載約 2.4 萬，vue-tsc 約 950 萬，還在 alpha，拿這麼少人用過的東西當 CI 關卡風險偏高。換回 vue-tsc 還能讓根目錄脫離 TS beta。
- 為什麼 `typecheck` 先 build：Nuxt UI 產生的 `components.d.ts` 用 `node_modules/.pnpm/<hash>/` 的路徑指向元件，檔頭有 `@ts-nocheck`。換 TS 版本之後 pnpm 的 peer hash 變了，舊檔指到不存在的路徑，元件型別安靜地變成 `any`，什麼錯都不報。先 build 讓它重新產生。
- 驗證：故意打錯 template 欄位（`item.titel`）、在 `UCard` 加不存在的 `aria-label`，兩個都會報錯。`UButton` 加不存在的 prop 或 `size` 給錯值不會報錯，是 Nuxt UI 的 `UButton` 型別本身放寬（D56 已記）。
- 重新檢視：Vue Language Tools v4 出正式版、下載量起來之後，看要不要回到 content-mapper，讓 `web` 不用多養一份 TS。

## D59 S2：人移動 item 的 status
- 決定：
  - `StoragePort` 加 `get` 與 `transition(ref, expectedFrom, to)`。`transition` 回傳移完的 `WorkUnit`，比照 `createItem`，因為剛寫完的呼叫端不能重新 `list`（D54）。找不到 ref 丟 `NotFound`，`expectedFrom` 對不上丟 `StatusConflict`，裡面帶 item 現在的樣子。
  - architecture.md 草稿裡 `transition` 的 `actor` 參數先不放。D57 說記錄操作者等有那個切片再做，現在放進去沒有人讀。
  - sqlite 的 compare-and-set 是一條 `UPDATE … WHERE ref = ? AND status = ?`，真的原子。Jira 是轉移前重讀一次 status，照 stop-and-recovery.md 接受兩次呼叫之間的小視窗。
  - Jira 的 `get` 遇到別的 project 或不是 item 的 issue type 也當 `NotFound`，tasuki 只動自己管的 issue。
  - use case `moveItem`：`from` 與目標 status 都必須是看板上的欄（config 有對照），而且兩者不能一樣，否則 `InvalidInput`。任何 status 到任何 status 都可以（state-machine.md）。
  - REST 是 `POST /api/items/:ref/transition`，body `{ from, to }`。衝突回 409，body 帶 `item`；`NotFound` 回 404。使用者 MCP 加 `move_item(ref, from, to)`，同一個 use case（D57）。
  - 看板：卡片用原生 HTML5 drag 拖到別欄，另外有「Move」下拉選單給鍵盤操作。放下就先把卡片移過去並鎖住，等回應期間不能再移，因為第二次移動會帶著舊的 `from`，撞上自己造成的衝突。回應後把回傳的 item 放到對應欄位，不重新讀取；其他錯誤放回原欄。409 時把卡片放到 item 現在所在的欄，跳 warning toast 說誰的 item 被別人移到哪。
  - StoragePort 契約測試加 `get`、`transition`、衝突、`NotFound` 四條，fixture 要對照 `refining`、`ready-to-split`、`in-progress`。整套 timeout 拉到 30 秒，Jira 一條測試要來回七八次。
  - Jira 的測試設定從 `JIRA_TEST_REFINING_STATUS` 改成 `JIRA_TEST_ITEM_STATUSES`，值是邏輯名對 status id 的 JSON。契約測試與 E2E 共用。
- 理由：衝突一定會發生在「人看到的是舊資料」的時候，所以 `from` 由人看到的畫面給，不由 server 補讀。拖拉不裝套件，因為 Nuxt UI 沒有 DnD，原生的寫起來只有幾行；下拉選單補上鍵盤操作，E2E 也好寫。
- KAN 的設定（2026-11-19）：用 Jira REST 的 `POST /rest/api/3/workflows/update` 在 team-managed 的 workflow 加了六個 status（`10006` 到 `10011`），每個各一條 GLOBAL 轉移，所以任何 status 都能轉到任何 status。原本的 `待辦事項`、`進行中`、`審核中`、`完成` 對到 `refining`、`in-progress`、`in-review`、`done`。這個 API 可以改 team-managed 的 workflow，待釐清 14 要做「代為去改 Jira」時可以走這條。注意要帶上既有 status 的 `id`，不然會被當成新的 status，名稱重複而失敗；新的 status 用 UUID 當 `statusReference`。
- 實測：E2E 在 Jira 上第一次跑時，S1 那條會超時。看板從一欄變十欄後每次讀取要 0.7 到 1.2 秒，而重新整理的迴圈只等 1 秒就再重新整理，看板永遠來不及出現。改成每輪等 `/api/board` 的回應回來才檢查。
- 重新檢視：有記錄操作者的切片時（把 `actor` 加回 `transition`）；Jira 的小視窗真的造成問題時。

## D60 部署到公司伺服器時的 auth 細節
- 背景：作者確認 tasuki 之後會部署在伺服器上給公司用。security-and-auth.md 原本定了登入方式與綁定檢查，但沒講 TLS、token 放哪、`/mcp` 怎麼登入、`static` 的密碼怎麼存、怎麼擋暴力破解。
- 決定：
  - engine 不做 TLS，非 loopback 的部署放在 HTTPS 的 reverse proxy 或 ingress 後面。新增 `server.publicUrl`，非 loopback 時必填且是 `https`，`Host` 與 `Origin` 檢查都拿它比對。
  - 看板的 session 放 `HttpOnly`、`Secure`、`SameSite=Lax` 的 cookie，session 存在 runtime store（只存 hash），登出立刻失效。會改東西的請求檢查 `Origin`。
  - `/mcp` 只收個人 API token（Bearer），在看板上產生、只顯示一次、存 hash、可撤銷，不吃 cookie。
  - `static` 的密碼在 config 裡存 scrypt hash，明文就拒絕啟動。
  - 登入失敗以帳號計數，回應延遲從 1 秒加倍到 30 秒，不鎖帳號。
  - 除了 `/api/health` 與登入，所有 route 預設要驗證。
  - 登入就有完整權限，不做角色與權限。RBAC 從「還沒決定要不要做」移到「刻意不做」。
- 理由：
  - TLS 交給 proxy：公司環境本來就有一層，憑證在那裡管，engine 少一份要輪替的東西。
  - cookie 加 `HttpOnly` 讓 XSS 偷不到 session；`Lax` 讓從 Slack 點連結進來還是登入狀態；`Origin` 補上 `Lax` 擋不到的情況。
  - `/mcp` 的 client 是設定檔裡寫死 token 的 AI 工具，不會走登入表單；只收 Bearer，瀏覽器發的跨站請求就帶不到身分。
  - 以帳號計數而不是 IP，不用信任 proxy 帶的 header；不鎖帳號，避免任何人都能把別人鎖在外面。
  - 作者確認目前不需要分權限。
- 重新檢視：有使用者需要唯讀或只能看部分 item 的角色時；要支援多 instance 時（失敗計數要搬出記憶體）；有人要求 engine 直接對外提供 HTTPS 時。
- 後續：「不做角色與權限」、`static` 的 scrypt 密碼、24 小時的 ttl、失敗一次就延遲，被 D89 推翻。其他照舊。

## D61 S3：item 詳情、編輯、markdown、comment 與附件
- 範圍：作者決定 S3 除了看內容與留言，也做編輯 title 與 body、markdown、附件（上傳、下載、貼進 body）。詳情用置中的 modal。
- 決定：
  - `StoragePort` 加 `updateItem`、`comments`、`addComment`（回傳 Comment）、`attachments`、`addAttachment`、`readAttachment`。`WorkUnit` 加不透明的 `version`，編輯帶著開始時的 version，對不上丟 `EditConflict`（REST 409，帶 item 現在的樣子）。沒改的欄位不送。
  - version 只跟 title、body、status 有關：sqlite 是每次改這三個欄位加一的整數，Jira 是這三個欄位的 hash。不用 Jira 的 `updated`，因為留言、上傳附件也會改它，「開始編輯、上傳圖、插進 body、存檔」這條最常見的路會被誤判成衝突。
  - body 與 comment 是 markdown，單一換行就是換行。看板用 markdown-it 畫（關 HTML、關 linkify）；Jira 用 marklassian 轉 ADF，ADF 轉回 markdown 自己寫（找不到夠多人用、還在維護的套件）。
  - markdown 表達不了的 Jira 內容（mention、表格、panel、沒對到附件的圖）寫成 embed token，帶著原本的節點，存回去原樣放回。底線、文字顏色、上下標、對齊會掉，作者接受。
  - comment：人在看板上留的是 `human`、`note`；agent 與 engine 的 comment 在 Jira 帶 comment property `tasuki` 與一行看得見的「tasuki · agent · question」標記，讀的時候拿掉。沒有 property 的一律當人寫的，所以直接在 Jira 網頁留言也是 human。登入（S9）之前，sqlite 的人沒有名字，畫面顯示「You」；Jira 顯示 Jira 帳號的名字。
  - 附件：最大 10 MB；sqlite 存成 BLOB；只有點陣圖在瀏覽器裡直接顯示，其餘強制下載（security-and-auth.md）。body 用 `![說明](attachment:<id>)` 引用。
  - 使用者 MCP 加 `get_item`、`update_item`、`add_comment`、`add_attachment`、`get_attachment`。圖片附件用 MCP 的 image 回傳。
  - Jira client 每個請求 30 秒 timeout。
  - 編輯 body 用 Nuxt UI 的 `UEditor`（TipTap，所見即所得），作者選的。markdown 進、markdown 出，`breaks: true` 讓單一換行就是換行。embed token 在編輯器裡是一顆刪得掉、改不了的小方塊，存回去一字不差；圖片節點保留 `attachment:<id>`，只在畫面上換成下載網址。存檔前把 TipTap 的硬換行（行尾兩個空白）換回單一換行，字中間的 `\_` 還原成 `_`。`_em_` 會被改寫成 `*em*`，意思一樣，接受。
  - 工具列用文字按鈕不用圖示：Nuxt UI 沒裝圖示集時會在執行時向 Iconify API 抓圖示，公司內網連不到就整排空白。
  - `web` 直接依賴 `@tiptap/core` 與 `@tiptap/extension-image`（版本跟 Nuxt UI 用的同一份），並在 Vite 的 `optimizeDeps.exclude` 排除它們：預打包會讓頁面多一份 ProseMirror，編輯器起不來（`Adding different instances of a keyed plugin`）。只影響開發模式。
  - 整張卡片都能點開詳情，靠標題按鈕的 `::after` 蓋住整張卡，鍵盤一樣只有一個可聚焦的按鈕；Move 疊在上面。
- Jira 的實測（2026-11-19、20，KAN）：
  - comment property 可以在建立 comment 時一起帶，`expand=properties` 一次讀回。
  - ADF 的圖片節點只認附件的 media id（UUID），填數字的附件 id 回 `ATTACHMENT_VALIDATION_ERROR`。上傳 API 與附件 API 都不給 media id；`GET /attachment/content/{id}` 不跟轉址時，`Location` 是 `https://api.media.atlassian.com/file/<media id>/binary?...`，從這裡取。不是公開 API，見 plan.md 的風險。
  - 讀的方向，media id 對附件 id 只有 `expand=renderedFields` 的 HTML 裡有（`href=".../attachment/content/<id>"` 與 `data-media-services-id`），所以只有 description 或 comment 真的有圖時才要 render。
  - 圖片節點帶 `alt` 時，Jira render 會整張圖略過，所以寫進 Jira 不帶 `alt`，讀回來用附件檔名當說明。自訂的圖片說明存到 Jira 會變回檔名。
  - 用 `external` 圖片節點指向 Jira 自己的附件網址，Jira 收下了，但讀那張 issue 的 render 會卡到逾時，所以絕對不寫這種節點；這也是加 timeout 的原因。
  - 上傳附件要帶 `X-Atlassian-Token: no-check`。
- 理由：作者要 Jira 與 sqlite 都能完整編輯，包含貼圖，而且編輯不能弄壞 Jira 上 tasuki 看不懂的內容。不能保留的只有樣式，字不會掉。
- 重新檢視：Atlassian 公開取得 media id 的 API，或轉址格式改變時；有人需要底線、顏色這類樣式時；附件需要超過 10 MB 時。
- 2026-11-20 補記：S3 只把詳情的編輯換成 `UEditor`，新增 item 的 Body 還是純文字框，作者發現兩邊不一致。新增也改用同一個編輯器與工具列（設定放在 `web/src/editor.ts` 共用），存檔前一樣經過 `toStoredMarkdown`。新增時還沒有 item，不能插附件的圖，所以只有文字的工具列。

## D62 依賴定版，升版經過 Dependabot
- 決定：
  - 所有 `package.json` 的依賴寫確切版本，`pnpm-workspace.yaml` 開 `saveExact`，之後 `pnpm add` 也定版。`peerDependencies`（testkit 的 `vitest`，D96 之前是 `vite-plus`）保留範圍，那是相容性的宣告。
  - pnpm 的 `minimumReleaseAge` 從預設的 1 天拉到 7 天：版本要公開滿 7 天才裝得進來。
  - GitHub Actions 釘 commit SHA，後面註解版本。
  - `.github/dependabot.yml`：npm（含 pnpm workspace）與 github-actions，每月 1 號、15 號早上 9 點（台北）各開一個合併的升版 PR，cooldown 7 天，跟 pnpm 一致，CI 才裝得下它提的版本。資安修補不受 cooldown 影響，有公告就開，前提是 repo 設定開了「Dependabot security updates」。
- 理由：作者要部署到公司，在意供應鏈。lockfile 加 CI 的 `--frozen-lockfile` 已經保證裝的是鎖定的版本，`^` 真正的風險在 `pnpm add`、`pnpm update` 時悄悄把範圍內的新版帶進來；定版讓每次升版都是一個要人看過的 diff。7 天是因為被劫持的版本多半幾天內就被發現下架。Action 的大版本標籤可以被作者移走（2025 年 tj-actions 事件），SHA 不行。每兩週是作者選的；Dependabot 沒有隔週的選項，用 1 號與 15 號近似。
- 過渡：拉長冷卻期時，lockfile 裡有 44 個版本（TipTap 3.34.0 一批、Playwright 1.65.1 等）發布還不滿 7 天，pnpm 拒絕安裝。它們是已經在用、測過的版本，用 `minimumReleaseAgeExclude` 只放行那些確切版本，2026-11-21 之後全部滿 7 天，整段刪掉。
- 資安修補不受 Dependabot 的 cooldown 影響，但 pnpm 的 `minimumReleaseAge` 還在：修補版發布不滿 7 天，CI 會裝不起來。這時在 `minimumReleaseAgeExclude` 只放行那一個確切版本，滿 7 天後刪掉。
- Dependabot 不提 `typescript` 與 `@types/node` 的大版本：web 要等 vue-tsc 支援 TS 7（D58）；`@types/node` 跟著 engine 跑的 Node 大版本，換 Node 時手動一起升。第一次跑時它提了這兩個，CI 在 `pnpm check` 擋下（vue-tsc 碰到 TS 7 的 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。
- 已驗證（2026-11-20）：Dependabot 讀得懂 pnpm 12 的 lockfile 與 workspace，github-actions 的檢查也正常。repo 的資安更新原本就是開的。
- 不修的警示：`esbuild` 0.27.x 的開發伺服器在 Windows 上能讀任意檔案（low），修在 0.28.1，但 esbuild 被 vite-plus 綁在 0.27.x。我們不用 esbuild 的開發伺服器、也不在 Windows 上跑，等 vite-plus 升版。
- 重新檢視：Dependabot 的 PR 太吵或太少時調頻率；要發布 npm 套件（S14，D97）時，看被別人安裝的套件是否改回範圍。

## D63 S4：規則命中，假 runner 跑 split
- 決定：
  - engine 在 `server`：每 `poll.intervalSeconds` 一輪，先復原 lease 過期的 Run，再認領。啟動時馬上跑第一輪。輪與輪不重疊。
  - 認領照 architecture.md 的順序：先 `createRun`（拿 lease），再把 item 從 watch 轉到 claim；轉移撞上 `StatusConflict` 就把這筆 Run 記成 `cancelled`。attempt 照 D38 算，超過 `maxAttempts` 就記一筆 `max_attempts` 的 Run，item 走 `on.max_attempts`（預設 `blocked`），留一則 system comment。
  - Run 結束：先轉移 item、再結束 Run、最後寫 system comment（outcome、去哪、原因、agent 的 summary）。中間當機只會留下會過期的 Run，不會留下卡在 claim status 又沒人管的 item。轉移撞上 `StatusConflict` 就是人接手，Run 記成 `cancelled`，不寫 comment。agent 回報的 verdict 在規則裡沒有出口時（例如 split 回 `blocked_manual`）當成 `failed`。
  - lease 復原：過期的 Run 記成 `abandoned`，item 還在 claim status 就送回 watch status 並留 comment。已經被人移走的不動。attempt + 1 不在這裡寫，是下一輪認領時由 D38 算出來的。
  - 每 `leaseSeconds / 3` 續約一次。`lastActivityAt` 還沒有更新的來源，先等於 `startedAt`。
  - verdict 驗證先不做，直接採信，只處理「沒有 verdict」與「exit code 非零」兩種 `failed`。split 的 `succeeded` 要求 item 底下有 task，S5 才有 task，現在做的話每次都是 `failed`。
  - MCP facade 提前一小塊：`/agent-mcp`，只收 `Authorization: Bearer <run token>`，tool 只有 `get_item`（不帶參數，讀被派的那張 item）與 `report_result`。run token 每個 Run 一個，只放記憶體，Run 結束就撤銷；engine 重啟本來就會讓所有 Run 變成 `abandoned`，token 不需要活過重啟。`report_result` 只收第一次，之後回錯。
  - 假 runner 是一個 runner plugin `@tasuki/fake-runner`，跟真的 agent 一樣用 HTTP 打 facade，沒有任何第三方拿不到的東西（D44）。它讀 item 的標題決定回報什麼：`[fake:needs_input]`、`[fake:failed]`、`[fake:blocked_manual]`，`[fake:hang]` 永遠不結束（拿來試 lease 復原：跑到一半把 server 砍掉，超過 `leaseSeconds` 再開）；其他都是 `succeeded`。`options.seconds` 是回報前等幾秒，預設 3。
  - config 的 agent 跟 tracker 同一種寫法：`{ plugin, options }`，原本說等 S8 再定的 `kind` 不用了。沒寫 `rules` 就是沒有規則，engine 不碰任何 item。啟動時檢查 config-and-rules.md 驗證的第 1 到 5 條，加上 `on` 只能用規則會移動的 outcome、規則名稱不重複。
  - `RuntimeStorePort` 放在 `core`（use case 要用），實作在 `server`，不是 plugin 角色。`createRun` 撞上「一張 item 一個存活的 Run」的 unique index 時丟 `RunConflict`。`Run` 加 `verdict`、`summary` 兩欄，存 agent 回報的內容，Run 結束時才換算成 outcome。DDL 只建 S4 用到的欄位，cancel、session、produced、usage 等用到的切片再加。
  - `getItem` 帶回 `runs`（新的在前），`listBoard` 帶回 `running`（有存活 Run 的 ref）。看板與使用者 MCP 都走這兩個 use case（D57）。看板卡片在有存活 Run 時顯示「Running」，詳情多一區 Runs。
  - 看板每 5 秒自己重讀一次，因為 engine 會自己移動 item。拖拉中、移動等回應中、以及我們剛寫完的 5 秒內不重讀：Jira 的列表會比寫入慢（D54），馬上重讀會讓卡片跳回原位一下。
  - E2E 的 engine 掛上假 runner 與 split 規則，poll 2 秒，假 runner 跑 10 秒，比看板重讀的間隔長，才看得到 Splitting 那一段。S2 的兩條 E2E 原本拖到 `ready-to-split`，現在會被 engine 認領，改拖到 `needs-answers`（第四欄，畫面內；第七欄的 In Review 在畫面外，Playwright 拖不到）。
- 理由：S4 是 engine 第一次真的跑規則。facade 提前做，是因為 verdict 照合約只能從 `report_result` 回來；讓假 runner 直接呼叫 use case 就是給內建 plugin 開後門。看板輪詢比 SSE 或 WebSocket 少一整套東西，五秒的延遲對「agent 在做事」這種畫面夠用。
- 重新檢視：Jira 的 rate limit 被輪詢打到時（看板 5 秒、engine 30 秒，D64 已經把每輪壓成一支搜尋）；要分辨人的移動時（D38 的已知限制）；S8 接上真的 CLI 時（RunSpec 加 prompt、env、session，RunHandle 加 terminate）。

## D64 `StoragePort.list` 一次查多個 status，看板背景時不重讀
- 決定：
  - `list(kind, statuses)` 收多個 status，回傳落在任一個 status 的 unit，舊的在前。Jira 送一支 `status in (...)` 的 JQL，sqlite 用 `IN`。空陣列回空，不打 tracker。
  - `listBoard` 一次撈整個看板，再依 unit 的 `status` 分欄；`claimItems` 一次撈所有規則的 watch status，再依規則順序認領。
  - 看板在瀏覽器分頁隱藏時（`document.hidden`）不重讀，切回來馬上讀一次，同樣遵守拖拉中、等回應中與寫入後 5 秒內不重讀。
- 理由：D63 的看板每 5 秒對每欄各送一支搜尋，10 欄就是 10 支，開幾個分頁就再乘幾倍。Jira 的 rate limit 是照呼叫算，合成一支之後看板一輪只剩一支（超過一頁才翻頁）。分頁隱藏時沒人在看，讀了也是白讀。
- 沒選的做法：只讀捲到畫面內的欄位，合成一支之後省不到東西，還要每欄自己記讀過沒；server 端快取多個請求的結果，要等多人同時看才值得；只撈 `updated` 之後的變動，抓不到刪除與移出 project 的 issue；Jira webhook 要公開的 URL，本機跑的接不到。
- 重新檢視：一個看板的 item 多到一支搜尋要翻很多頁時；多人同時看同一個看板時（再考慮 server 端快取）。

## D65 S5：task 與 `split-review` 放行
- 決定：
  - `StoragePort` 加 `children(item)`、`dependencies(item)`、`createTask(item, task)`。`children` 與 `dependencies` 要馬上看得到剛建的 task，因為 verdict 在 agent 建完之後立刻檢查。Jira 從 item 的 `subtasks` 欄位拿 key，再用 `POST /issue/bulkfetch` 讀，不走搜尋（D54 補記）。`createTask` 的 `blockedBy` 只能指同一張 item 的 task，否則丟 `InvalidInput`；指的不是 item 丟 `NotFound`。建 task 與建 link 是分開的呼叫（D47）。
  - `list('task', statuses)` 照 kind 用對應的 issue type。看板多一次 `list('task')` 算每張 item 的 task 數，卡片顯示「done/總數 tasks」，不為每張 item 各讀一次。
  - Jira：task 是 sub-task，`dependencyLinkType` 是 Blocks 的 link type id，從被擋住的 task 看 `inwardIssue` 是擋住它的那張（2026-11-20 在 KAN 實測）。origin 存在 issue property `tasuki`（`{ origin }`），跟 D61 的 comment property 同一個 key；沒有 property 的 sub-task 是人在 Jira 建的，當成 `human`。作者選 property 而不是 label：label 人可以隨手刪改，也會跟 `hold` 這種真正的 label 混在一起。`issueTypes.task` 與 `dependencyLinkType` 改成必填。Jira 的 `POST /issueLink` 回 201 沒有 body，client 遇到空 body 回 `undefined`。
  - KAN 的設定（2026-11-20）：team-managed 的 workflow 是所有 issue type 共用，原本就有 `待辦事項`、`進行中`、`審核中`、`完成`，對到 task 的 `to-do`、`in-progress`、`in-review`、`done`。用 D59 的同一支 API 加了 `Manual`（`10012`），一條 GLOBAL 轉移。Subtask 的 type id 是 `10007`，Blocks 是 `10000`。
  - facade 加 `list_tasks`、`create_task`（`initialStatus` 只能 `to-do` 或 `manual`，origin 一律 `splitter`）、`add_comment`（item 或它的 task，`kind` 是 `note` 或 `question`）。use case 在 `create_task` 與 `question` 時累加 Run 的 `produced`，存在 runtime store 的 `produced_tasks`、`produced_questions`。
  - verdict 驗證先做兩列：split 的 `succeeded` 要 item 底下至少一張 task（不論誰建的，D30）；`needs_input` 要這次 Run 至少一則 question。沒做到就是 `failed`，`Why:` 寫出缺什麼。其他列等 S6 以後對應的規則。
  - 放行與打回沒有新的 use case：詳情在 `split-review` 時多兩顆按鈕，Approve 移到 `in-progress`、Send back 移回 `refining`，走 `moveItem`，使用者 MCP 一樣用 `move_item`（D57）。打回時 task 留著，下次 split 由 agent 決定要不要重拆（D30）。沒有 task 時 Approve 不能按。
  - config：`statuses.task` 不認識的 status 拒絕啟動；有 split 規則時一定要對照 `to-do` 與 `manual`。省略整個 `statuses` 時 task 也對到顯示名。
  - 假 runner：沒有標記時，item 還沒有 task 就建兩張（第二張等第一張），再回報 `succeeded`；`[fake:needs_input]` 先留一則 question；`[fake:no_tasks]` 不建 task 就回報 `succeeded`，拿來看驗證擋下來的樣子。
  - `update_task`、`list_comments` 與詳情裡編輯 task 都還沒做，S5 用不到。
- 理由：S5 要讓人在 `split-review` 看得到 agent 拆了什麼再決定。verdict 驗證放在這裡，是因為有了 task 才驗得了 split，S4 先採信的那段（D63）在這裡收掉。
- 重新檢視：一個 project 的 sub-task 多到看板那支 `list('task')` 要翻很多頁時（改成只撈看板上 item 的 task）；S6 補其餘 verdict 驗證時；做 task 編輯時。

## D66 一個 tracker project 只接一個 engine，用心跳擋第二個
- 決定：
  - 一個 tracker project 同一時間只有一個 engine 在跑規則。不做多 engine 分工，`plan.md` 的「多 instance、高可用」維持不做。
  - 要跑更多 agent，往 runner 擴：先調大 `maxConcurrentRuns`；一台機器不夠，就寫一個把 agent 開在別台（container、k8s Job）的 runner plugin。engine 還是一個，`RunnerPort` 不用改。agent 在別台時，facade 的網址要改成對外的，這要等 S9 有 auth。
  - 擋第二個 engine 用心跳：engine 每輪在 tracker 寫一次 `{ engineId, lastSeen }`，Jira 用 project property。啟動時看到別人的心跳還新鮮，就拒絕啟動，並說出是哪一個 engine。sqlite 的 DB 檔只會被一個 process 開，不需要。放在 S10，跟 `doctor` 一起做。
- 理由：2026-11-20 跑 Jira E2E 時，作者的 `pnpm dev` 也接著 KAN、掛著同一條 split 規則，同一張 item 被兩個 engine 認領，假 runner 建了兩組 task。原因有兩個：
  - Run 與 lease 存在各自的 `runtime.db`（D2），不變量 1 只在一個 engine 裡擋得住。
  - Jira 的認領是先讀 status 再轉移（D59），兩個 engine 會同時通過。
  要讓多個 engine 安全分工，得把 runtime store 換成共用的資料庫，再加上分散式鎖。可是 engine 本身只負責 poll 跟看著 process，吃資源的是 agent，所以多個 engine 換不到什麼。真正會發生的是團隊每個人各跑一份 local 版、接同一個公司 Jira project。這時要的不是支援多個，而是擋下第二個。
- 沒選的做法：
  - 認領時在 issue 上寫 engine id 再讀回來比對。這只能把空窗縮小，擋不掉。
  - 共用 runtime store 加鎖。這是為了不存在的需求做分散式系統。
- 現在的狀態：S10 之前沒有任何偵測。同時開 `pnpm dev` 跟 Jira E2E 就會撞到，跑 Jira E2E 前要先關掉 dev。
- 重新檢視：engine 自己掛掉的停機時間變得不能接受時（目前靠 lease 復原，重開就接回去）；有人需要多個 engine 分工時。

## D67 engine 與它派出的 agent 移動東西都要留原因
- 決定：
  - 非人的移動，也就是 engine 與 engine 派出的 agent 造成的 item 或 task status 改變，一律在被移動的那張留一則 `system` comment 寫原因。人移動的不用，透過使用者 MCP 叫 AI 移動也算人（D57），`move_item` 不加 reason。
  - item：engine 照 verdict 移動時，comment 一定有 `Why:`（engine 自己判的）或 agent 的 summary。`report_result` 的 summary 空白直接回錯誤，不記錄。lease 過期送回、`max_attempts` 原本就有原因。
  - task：`set_task_status` 每次都要帶不能空白的 `reason`，engine 寫成該 task 的 comment。原本只有改成 `manual` 時要留 comment。S6 做 `set_task_status` 時照這條做。
  - 原因一兩句講重點，不寫成報告。tool 的描述照這樣要求 agent，prompt 在 S8 寫。
  - 認領（watch 移到 claim status）不留 comment：看板上的 Run 就是原因，每次都寫只會洗版。
- 理由：人回來看到 item 進了 `blocked`、task 被改成 `manual`，要不用翻 log 就知道為什麼。S5 以前 agent 回報 `failed` 時 summary 可以給空字串，comment 只剩 `failed, moved to blocked.`。reason 做成 tool 的必填參數而不是要求 agent 另外 `add_comment`，是因為參數 engine 擋得住，另外留言只能靠 prompt。
- 重新檢視：原因的 comment 多到洗掉人寫的討論時（例如 orchestrator 一個 Run 改幾十次 task status）。

## D68 看板每欄標出輪到 engine 還是人
- 決定：
  - `listBoard` 每欄多一個 `turn`：規則 watch 的欄是 `engine`，`AWAITING_PERSON`（`needs-answers`、`split-review`、`in-review`、`blocked`）是 `person`，其他不標。engine 那組從 config 的 rules 算，不寫死。看板與使用者 MCP 的 `list_board` 拿到同一份（D57）。
  - 看板在欄名前放 lucide 的 `radar`（engine，`info` 色）與 `eye`（人，等人 review 的意思，`warning` 色），hover 顯示說明，讀屏讀得到同一句。欄位的 accessible name 只指欄名，不含圖示說明。
  - 圖示打包進 bundle：`web` 裝 `@iconify-json/lucide`，Vite 的 `ui()` 用 `icon.clientBundle.icons` 點名要用的圖示，少一個 build 就失敗。裝了圖示集之後 Nuxt UI 自己元件的圖示也一起打包。D61 工具列用文字按鈕的理由（沒有圖示集會去打 Iconify API）因此不成立了，工具列先維持文字，要換時不用再顧慮這點。
- 理由：十欄外觀一樣，作者要讀欄名才知道哪幾欄在等自己、哪幾欄 engine 會自己處理。`refining` 是人在寫需求，不是在等確認，作者決定不標。
- 重新檢視：狀態機加了新的 status 時（決定它屬於哪一組）；規則能設成「等人」的 status 時。

## D69 S6：execute 與其餘的 verdict 驗證
- 決定：
  - 規則 B（`watch: in-progress`，沒有 claim）照 D63 的認領路徑跑，不加新的機制。item 一直留在 `in-progress`，靠「一張 item 一個存活的 Run」擋重複。lease 過期時 item 不動，但留一則 comment 說下一輪再試；item 已經被人移走就不留。
  - verdict 驗證補齊 agent-contract.md 表上的每一列：execute 的 `succeeded` 要所有 task 都 `done`；rework 的 `succeeded` 要這次 Run 建過 task；`blocked_manual` 要至少一張 `manual`，而且沒有任何 `to-do` 的 blockedBy 已全部 done。`Evidence` 從 task 數改成整份 task 清單（含 blockedBy），驗證跟 `set_task_status` 用同一個 `isRunnable`。execute 底下沒有 task 時，「全部 done」照字面成立。
  - facade 加 `set_task_status`，照 task 圖檢查（domain 的 `agentMoveRefusal`），reason 必填，engine 寫成那張 task 上的 `system` comment（D67）。facade 照規則的 mode 掛 tool：split 與 rework 有 `create_task`，execute 有 `set_task_status`，兩邊互斥。
  - 不變量 3 由 engine 做：Run 結束時（`cancelled` 除外）與 lease 過期時，把 item 底下殘留的 `in-progress` task 送回 `to-do`，每張留一則原因。`cancelled` 是人接手了，照不變量 6 不動任何 status，殘留的留給下一個 agent 照合約自己處理。
  - lease 過期時先讀一次 item，已經不在 tracker 就只把 Run 記成 `abandoned`。原本 NotFound 會從復原丟出去，每一輪 poll 都在同一筆 Run 停下，後面的認領全部停擺；split 規則的 transition 本來就有這個洞，S6 加的讀取與送回 task 讓每條規則都會撞到。Run 結束時 item 不在，`finishRun` 一樣會丟錯，Run 留著等 lease 過期，再由這裡收掉。
  - 有 execute 規則時，`statuses.task` 五個都要對照。
  - 人的操作：詳情在 `in-review` 時多一顆 Accept，移到 `done`，走 `moveItem`，使用者 MCP 一樣用 `move_item`（D57）。打回 `ready-to-rework` 的按鈕跟規則 C 一起放 S7。Send back、Approve、Accept 成功後關掉詳情，決定做完就沒有事要在這裡做了；撞上 `StatusConflict` 時留著，讓人看到它現在在哪。
  - 假 runner 照 `RunSpec.mode` 分：execute 依序把能跑的 task 走完 `in-progress`、`in-review`、`done`，剩下 manual 就回報 `blocked_manual`。split 多一個 `[fake:manual]`，讓第二張 task 是 manual，拿來走 blocked 那條。
  - 人改 task status（接手、交回、manual 做完）放 S7，跟 blocked 自動接回一起做。
- 理由：沒有 Run 的 item 底下掛著 In Progress 的 task，人要多想一下才知道它是假的。engine 送回去的代價是 Run 結束時多讀一次 task、多幾個 transition，換到的是看板不說謊，而且不變量 3 變成測得到的行為。之前把它留給 agent，是因為 M1 的 orchestrator 才知道 subagent 在做什麼。但 Run 一結束，這件事就沒有人知道了，engine 送回去不會跟 agent 衝突。
- 重新檢視：M2 由 engine 自己派 task 時（送回改成 engine 派發的一部分）；人在詳情看不到 task 上的 comment（sqlite 模式下 D67 的原因只在 DB 裡），做 task 詳情時一起補。

## D70 S7a：task 詳情、人改 task status、在 `split-review` 修 task
- 決定：
  - S7 太大，拆成 S7a 到 S7d，每段都能在瀏覽器操作（D41）。S7a 先做，因為 S7b 的自動接回要等人把 manual task 標成 `done`。
  - task 詳情：item 詳情的 task 清單點下去開第二層 modal，顯示內文、origin、等哪幾張、comment（engine 與 agent 留的原因就在這裡，D67）與留言框。新的 use case `getTask`，REST 是 `/api/tasks/:ref`，使用者 MCP 加 `get_task`；`add_comment` 原本就能留在 task 上，描述改成 item 或 task（D57）。
  - 人改 task status 只走 task 圖上人的四條邊：接手（`to-do`、`in-progress` 到 `manual`）、交回（`manual` 到 `to-do`）、做完（`manual` 到 `done`）。domain 的 `personMoveRefusal` 擋其他的，`done` 不能重開（待釐清 12）。use case `moveTask`，跟 item 一樣用 compare-and-set，撞上 `StatusConflict` 回 409。人移動不留原因（D67）。Run 還在跑時接手也可以，只是 soft stop（M1）。
  - 修 task：item 在 `split-review` 時才能改 title、body 或刪除，其他時候 `InvalidInput`（D86 改成 item 沒有存活的 Run 就能改）。拆之前 splitter 還在建，放行之後 agent 可能正照著做。改內容沿用 `StoragePort.updateItem`（兩邊本來就吃 task）。blockedBy 不開放改，要兩邊都補拆 link 的寫入，這次換不到什麼；要改依賴就打回重拆。
  - `StoragePort.deleteTask`：連它兩個方向的 dependency、comment、附件一起刪，等它的 task 從此不等。sqlite 包在一個 transaction 裡；Jira 用 `DELETE /issue/{key}`，link、comment、附件由 Jira 一起刪。刪除不帶 version，畫面上要先按一次再確認。
  - sqlite 的 ref 原本是 `MAX(rowid) + 1`，刪掉最後一張之後下一張會拿到同一個 ref，舊 comment、log 裡的 ref 就指錯東西。改成 `ref_counter` 表發號，migration 從現有的 `MAX(rowid)` 起算，已經發出去的 ref 不變。契約測試多一條：刪掉之後新建的 task 不會撞到舊 ref。
- 理由：splitter 拆得差不多但有一兩張不對時，原本只能打回重拆，等一輪 agent。人在 `split-review` 直接修，前台省一次重跑，後台只多一個 port 方法和一個狀態檢查。
- 沒選的做法：任何時候都能改 task，`in-progress` 時會跟 orchestrator 讀到的內容打架；sqlite 軟刪除，每個查詢都要多一個條件。
- 重新檢視：要在 `split-review` 調整依賴時（補 blockedBy 的寫入）；agent facade 的 `update_task`（agent-contract.md）做的時候，跟這裡共用驗證。

## D71 S7b：blocked 自動接回與 rework
- 決定：
  - 自動接回是 core 的 `resumeBlocked`，engine 每輪在 `recoverRuns` 之後、`claimItems` 之前跑，接回的 item 同一輪就被認領。先問本機的 runtime store 有沒有「最近一次 Run 停在 `blocked_manual`」的 item（`RuntimeStorePort.latestRunsEndedIn`），沒有就整輪不碰 tracker；有才對 tracker 搜一次。第一版每輪都對 Jira 多一支搜尋，E2E 每 2 秒一輪，整包跑時另外兩條 Jira E2E 被拖慢到逾時，單獨跑又會過。只看規則 `on.blocked_manual` 指到的 status，三個條件照 state-machine.md：最近一次 Run 是 `blocked_manual`（而且已經結束）、item 底下沒有 `manual` 的 task、沒有 hold label。接回到那條規則的 watch status，留一則 system comment（D67）。撞上 `StatusConflict` 或 `NotFound` 就跳過那張，不擋住這一輪。
  - 「擋住的 manual task」讀成「現在所有的 manual task」。runtime store 沒記當初是哪幾張擋住的，要記得多一欄；人在 blocked 期間新增的 manual 本來就該等。人把 manual 交回 `to-do` 也會接回，下一個 Run 去做它。
  - hold label 的名稱先寫死成 `hold`（engine 的常數），config 的 `labels.hold` 跟 hold 的其他行為在 S7c 一起接。
  - rework：人在 `in-review` 按 Rework，一定要寫回饋才送得出去。use case `requestRework` 先確認 item 還在人看到的 status，再留 comment，最後移到 `ready-to-rework`。順序是 comment 在前：規則 C 可能一移過去就認領，agent 只能從這則 comment 知道要改什麼。item 已經被移走時不留 comment，回 409。REST 是 `POST /api/items/:ref/rework`，使用者 MCP 加 `request_rework`（D57）。從 `blocked` 拖到 `ready-to-rework` 還是一般的 `moveItem`，不強制回饋。
  - agent facade 加 `list_comments`（item 或它的 task，跟 `add_comment` 共用同一個範圍檢查），split、execute、rework 都有。
  - config：有 rework 規則時，`statuses.task` 一樣要對照 `to-do` 與 `manual`，rework 也會建 task。
  - 假 runner 的 rework 模式建一張 `Rework` task，內容是最新一則人寫的 comment，再回報 `succeeded`。
  - 順手修掉 S4 起就有的看板 bug：`listBoard` 原本跟 tracker 的搜尋同時讀 `liveRuns`，本機一下就回來，Jira 要搜好幾秒。Run 在這段時間結束的話，卡片已經在結果的欄位上，卻還掛著 Running，要等下一次重讀才消失。改成 tracker 讀完才讀 `liveRuns`，Running 只會比卡片新。Jira E2E 整包跑時兩次卡在 Split Review 的 Running 就是這個。
- 理由：自動接回讓人做完 manual 就不用再回來拖卡片，前台省一次思考，後台是一個每輪跑的 use case，沒有新的 status。回饋必填是因為 rework 的 agent 除了 comment 沒有別的依據，空的回饋只會換到一輪白跑。
- 重新檢視：Jira 上 blocked 的 item 多到每輪的 `children` 呼叫吃掉 rate limit 時（每張停在 blocked、最近一次是 `blocked_manual` 的 item 每輪讀一次 task）；被人直接移出 blocked 的 item，最近一次 Run 會一直是 `blocked_manual`，讓閘門每輪都打開，這種多到常態時（改成記住接回或移走過的）；S7c 接上 `labels.hold` 時拿掉常數。

## D72 S7c：Stop、hold、人移走視為接手
- 決定：
  - 按 Stop 時順手貼上 `hold`。文件原本只說 `cancelled` 不動 status，沒寫 Stop 之後怎麼辦。照字面做，item 停在 `in-progress` 下一輪就再起一個 Run，停在 `splitting` 復原就把它送回 `ready-to-split` 重跑，按了等於沒按。貼上 hold，卡片掛 On hold，人拿掉才繼續，接回的路照 stop-and-recovery.md 原本寫的走。不變量 6 不用破例。
  - `StoragePort` 加 `addLabel` 與 `removeLabel`，一次只寫一個 label，不動 version（version 只跟 title、body、status 走）。sqlite 在同一個 process 裡同步讀改寫；Jira 用 `update.labels` 的 add / remove，不會蓋掉別人同時貼的 label。契約測試兩邊跑同一條。hold 一直都是 `labels` 裡的一個字串，兩邊都不用另外開欄位。
  - Run 加 `cancelRequestedAt`、`cancelMode`、`cancelRequestedBy`（`stop`、`hold`、`moved`），runtime store 的 migration 加三欄。`requestCancel` 只記第一次的時間與原因，hard 會把 soft 升級，反過來不會（原因的部分 D73 改成 hard 的優先）。原本文件寫 `by = 'human-override'`，改成分開記三種，結束時的 comment 才說得出是誰停的。
  - 偵測（core 的 `detectOverrides`）每輪在復原之後跑，每個存活的 Run 讀一次 item，沒有 Run 就不讀。原本寫 tick 與 lease 續約時都查，續約時再查等於 Jira 的呼叫多一倍，換不到什麼：tick 本來就比續約頻繁。看板與使用者 MCP 貼 hold 時有 Run 就當場 soft cancel，只有在 Jira 直接動的才等偵測。
  - 砍 process 不走 Poller：engine 多一個 `enforce()`，server 每秒跑一次，只讀本機 runtime store。hard 送 SIGTERM，soft 超過 `softGraceSeconds`（300）升級，SIGTERM 之後超過 `hardGraceSeconds`（10）送 SIGKILL。寬限由 engine 計時，所以 `RunHandle` 只要 `terminate(signal)`，不是原本寫的 `terminate(grace)`。現在只有假 runner，它在同一個 process 裡，兩種訊號都立刻結束；真的 process tree 留給 S8 的 claude runner。
  - `finishRun` 先看有沒有取消請求：有就記 `cancelled`，不轉移、不送回 task（不變量 6），留一則 system comment 寫原因與 agent 的 summary。agent facade 的寫入類 tool 在取消後丟 `RUN_CANCELLED` 開頭的錯誤，`report_result` 回 ok 但不記。
  - hold 拿掉後，停在 claim status 的 item 由 core 的 `resumeReleased` 送回 watch status，同一輪就被認領。閘門跟 D71 一樣先問 runtime store：最近一次 Run 是被 Stop 或 hold 取消的才算，被人移走而取消的不算，人已經決定它去哪了。`claimItems` 跳過有 hold 的 item，不變量 5 到這裡才做完整，S7b 只在自動接回時看了 hold。
  - config 接上 `labels.hold`（預設 `hold`，要是一個不含空白的字）與兩個寬限秒數，拿掉 engine 的常數。看板的回應多一個 `holdLabel`，前端拿它比 `item.labels` 顯示 On hold，詳情裡改 hold 之後卡片跟著更新，不用等重讀。
  - 畫面：item 詳情有 Run 在跑時多一顆 Stop，另外一直有 Hold / Release。按了 Stop 之後詳情每秒重讀，直到 Run 結束，不然會一直停在 stopping。使用者 MCP 加 `stop_run`、`hold_item`、`release_item`（D57）。
- 理由：Stop 不貼 hold 就沒有意義，貼了之後所有「接著怎麼辦」都落在已經寫好的 hold 規則裡，後台不多一個 status，前台一個 On hold 就說清楚是人叫它停的。
- 沒選的做法：Run 被取消後把 claim status 的 item 直接送回 watch status，卡片會在 Ready to Split 掛 On hold，看起來也清楚。但要破不變量 6，被人移走而取消的又不能送，例外比現在多。
- 重新檢視：被 Stop 或 hold 停下的 item 之後被人直接移走、一直沒再跑，最近一次 Run 會一直是取消的，`resumeReleased` 的閘門每輪都打開（每輪對 tracker 多一次搜尋），這種多到常態時，跟 D71 一起改成記住處理過的；S8 的真 runner 要驗證 SIGTERM 真的送到整個 process tree。

## D73 S7d：全域 pause
- 決定：
  - 旗標放 runtime store 的 `engine_state`（`key = 'paused'`），server 重開還在。port 是 `isPaused` 與 `setPaused`，不是原本草稿的通用 `getState` / `setState`：目前只有這一個狀態，通用的 key-value 換不到什麼。
  - 暫停只擋 `claimItems`。lease 復原、偵測、自動接回、`resumeReleased` 與 `enforce` 照跑，它們都不會開新的 Run。全部停掉的話，lease 過期的 Run 不會被收、被 Stop 的 agent 不會收到訊號。
  - `pause --kill` 對每個存活的 Run 送 hard cancel，原因記成新的 `pause`，不貼 hold。恢復之後自己接著跑：watch status 的直接被認領，claim status 的由 `resumeReleased` 送回 watch status，留一則寫明是暫停停掉的 comment。另一種是每張都貼 hold，恢復後要一張一張 Release，那就變成 Stop 了；pause 的意思是整台先停、等等一起繼續。
  - `cancel_requested_by` 的 CHECK 是 S7c 用 `ALTER TABLE ADD COLUMN` 加的，SQLite 不能就地改 CHECK，作者本機的 runtime.db 也已經跑過那支 migration，不能回頭改。所以 S7d 的 migration 照 SQLite 文件的做法重建 `run`：建新表、搬資料、刪舊表、改名，再建回兩個 index。每支 migration 包在 transaction 裡，中途失敗整支 rollback。測試從第 3 版帶一筆 Run 升上來，確認資料與 index 都在。
  - REST 是 `POST /api/engine/pause`（`{ kill }`）與 `POST /api/engine/resume`，看板的回應多一個 `paused`。使用者 MCP 加 `pause_engine` 與 `resume_engine`（D57）。CLI 的 `pause` / `pause --kill` 要等 S12 有 CLI，到時呼叫同一個 use case。
  - 修正 D72 的「只記第一次的原因」：hard 把 soft 升級時，原因換成 hard 的那個。整包 E2E 在 Jira 抓到的 race：Stop 先貼 hold（Jira 要好幾秒），這段時間 engine 剛好跑一輪，偵測看到 hold 先記了 soft 的 `hold`，Stop 的 hard 到了原因卻被丟掉，comment 寫成「被貼了 hold」。順序不能反過來，先 cancel 的話 Run 一秒內就死，hold 還沒貼上，下一輪會被重新認領。engine 測試多一條，在舊規則下會紅。
  - E2E 的 pause 測試放在最後一條，`afterEach` 每條都 resume 一次。第一次跑時那條逾時，逾時之後 `finally` 拿到的 `request` 已經被收掉，resume 沒送出去，engine 停在暫停，重試全部跟著失敗，拖了 15 分鐘。那次逾時的原因沒查到（trace 被後面的重試蓋掉），之後單跑 4 次都在 40 秒內過。
- 理由：暫停是給維護、換 agent 設定、沒 token 時用的，人要的是「先別動，等等照原樣繼續」。後台只多一個旗標、一個 cancel 原因與一張表的重建，前台一顆按鈕一條提示。
- 重新檢視：多了別的 engine 狀態要存時（再考慮通用的 key-value）；pause 那條 E2E 再逾時一次，先開 `--trace=retain-on-failure` 找原因。

## D74 S7e：作者試用 S7 之後的回饋
- 決定：
  - 預設規則（split、execute、rework）都不設 `claim`。卡片已經有 Running，claim status 只是讓同一件事多一欄，而且 rework 借用 `splitting` 時，item 會跳進一個名字不對的欄位。claim 功能保留（E2E 的 config 還在用），D33 的備案「規則 C 省略 claim」就是這個，當初否決的理由「畫面看不出處理中」已經不成立。`splitting` 是唯一只有 claim 才會用到的 status（core 的 `CLAIM_ONLY`），沒寫 `statuses` 時只在有規則 claim 它才對照，不然看板多一欄永遠是空的。rework 不合進 `ready-to-split`：一個 status 只能有一條規則 watch，兩種工作的驗收也不同（rework 一定要開新 task），欄名也會分不出新的還是打回來的（D32）。
  - 刪除 item：`StoragePort.deleteItem` 連 task、comment、附件一起刪，sqlite 包在一個 transaction，Jira 用 `DELETE /issue/{key}?deleteSubtasks=true`。有存活的 Run 時拒絕，要先 Stop。runtime store 的 Run 留著當歷史。詳情的 More 選單裡，要確認一次。使用者 MCP 加 `delete_item`。
  - 改 D70：人可以把 `done` 的 task 改回 `to-do` 或 `manual`，修正按錯。只在 item 沒有存活的 Run 時可以，agent 可能正依賴它是 done。engine 與 agent 照舊不重開（不變量 4 改寫成只約束它們）。不開放任意拖拉，task 的狀態大多是 agent 在推。
  - 人在看板或使用者 MCP 的操作（移動 item 或 task、hold、release、Stop）都留一則固定格式的 comment，author 是人、kind 是 `system`，例如「Moved from manual to done.」，誰與什麼時候由 comment 本身記著。不用 `note`：rework 的 agent 拿人最新的 note 當回饋，假 runner 與 engine 測試都曾經因此讀到「Moved from in-review to ready-to-rework.」。Jira 原本只在 agent 與 engine 的 comment 上掛 property，人的 `system` 讀回來會變成 `note`，所以人的 `system` 也掛 property，不加看得見的標記。契約測試多一則人的 `system`。
  - 卡片上的 Move 下拉搬進詳情的 More 選單，它是不能拖拉時的替代方案，不能整個刪。移動仍由看板做，衝突的 toast 與樂觀更新是同一套。
  - 看板：第一次載入顯示 loading；agent 被要求停下時卡片顯示 Stopping，不再寫 Running（看板回應多一個 `stopping`）；拖到左右邊緣自動捲動。剛建立或移動的卡片記住「寫入前看板上的樣子」，重讀時搜尋還是那個樣子（或還沒列出）就保留我們的版本，列出別的東西就代表搜尋已經比我們新，交給它，engine 接著做的移動也不會被蓋掉（D54）。
  - 詳情：用看板上已有的卡片秒開標題、內文、狀態，task、Run、comment 讀到之前顯示 loading，不另外快取。看板重讀時這張的 status、version、label 或 Run 變了，詳情就重讀，編輯中不讀；不另外輪詢，Jira 上一張詳情要四、五支 API。看板觸發的重讀會跟人的操作重疊，所以兩條規則：本地有寫入時，比它早開始的讀取丟掉重讀；await 回來之後寫進當下顯示的那份詳情，不寫進送出前抓住的那份。Jira E2E 抓到過後者：送 comment 的途中重讀先回來換掉了詳情，comment 被塞進已經不顯示的舊物件，畫面上就消失了。當時懷疑是 Jira 剛 POST 的 comment 讀不到，實測連續 8 次 POST 完馬上 GET 都讀得到，不是這個原因。每次打開都清掉上次的草稿（rework 回饋、comment、編輯、刪除確認）。task 整列可點，狀態對齊成一欄並依狀態上色；Delete task 移到檢視模式；按鈕統一成框線樣式；決定類按鈕寫出去處（Approve and start、Accept as done、Send back to Refining）。
- 理由：都是作者實際操作時卡住的地方，多數只動前端，後台多的是一個 port 方法（`deleteItem`）、一條放寬的狀態邊與一種 comment。
- 重新檢視：人的操作紀錄讓 Jira 的 comment 太吵時（改成只在 sqlite 留，Jira 靠它自己的 history）；看板重讀觸發的詳情重讀在 Jira 上太慢或太常時。

## D75 沒有回饋的 rework 不開跑
- 決定：
  - 兩層。畫面能擋就擋：卡片拖進 `ready-to-rework`，或從詳情的 Move to 選它，都先要一段回饋，沒寫送不出去，取消就留在原地；使用者 MCP 的 `request_rework` 本來就強制要寫。擋不到的交給 engine：在 Jira 直接拖過去的，或任何沒經過 tasuki 的移動。
  - engine 認領 rework 規則之前，先看上一個 Run（這張 item 的任何規則）結束之後，有沒有一則人寫的 note。有就照常開跑，agent 拿最新那則當回饋。沒有就不派 agent，item 走這條規則的 `needs_input` 出口（預設的 rework 規則是 `blocked`），留一則 system comment 請人寫好再移回來。同事在 Jira 先寫 comment 再拖，Jira 上人寫的 comment 讀回來就是 note，會照常開跑。
  - 去 `blocked` 不去 `in-review`：卡片可能從 `blocked`、`done` 或任何一欄拖過去，`in-review` 的意思是做完了等驗收，不一定成立；而且那等於 engine 沒有 outcome 就自己移 item，狀態機沒有這條路。`blocked` 本來就是卡住了要人處理，而 `needs_input` 正是 rework 的 agent 自己要回饋時會走的出口。
  - 時間比的是 engine 的時鐘（Run 的 `finishedAt`）與 tracker 的時鐘（comment 的 `createdAt`），兩邊差幾秒內不影響。
  - 詳情裡的回饋表單搬到標題下面，Rework 按鈕與 Move to 共用。看板自己的回饋框只給拖拉用：reka-ui 的 dialog 開著時會擋掉它外面的所有點擊，從詳情叫出看板的框會點不到，E2E 抓到的。
  - 三種用法都要顧：自己在本機用 sqlite、架在 VM 上大家用、大家在 Jira 上協作而作者在本機接 Jira。前兩種所有操作都經過 tasuki 的畫面或 MCP，第一層就擋住；第三種靠第二層。
- 理由：沒有回饋的 rework，agent 開不出有意義的 task，最好的情況是被驗收判成 `failed` 掉進 `blocked`，等於白跑一輪還看不出原因。認領前多讀一次 comment（Jira 上一支 API），換到的是不白跑、而且留言直接說要補什麼。
- 重新檢視：有人希望沒寫回饋也能重跑（例如只想換個 agent 再試一次）時，改成規則上的選項。

## D76 S8：真的 claude runner
- 決定：
  - 新套件 `@tasuki/claude-cli`，跟其他 plugin 走同一條載入路徑。每個 Run spawn 一次 `claude -p <prompt> --output-format stream-json --verbose`，cwd 是 item 的 workspace，自己一個 process group（`detached`），`terminate` 對整個 group 送訊號，CLI 叫起來的子 process 一起停。
  - 權限：`--permission-mode dontAsk`，`--allowedTools` 一律是 `mcp__tasuki` 加上 `options.allowedTools`。白名單外的 tool 直接拒絕，不會停下來等人（D35）。
  - 預設隔離：`--setting-sources ""` 加 `--strict-mcp-config`，agent 不載入這台機器的 Claude 設定、CLAUDE.md、hooks、plugin、MCP server，同一個 Run 換台機器跑結果一樣。`options.inheritSettings: true` 改成跟互動 session 一樣全部載入，要用自己裝的 skill 或 MCP 時開。`requires` 的檢查留給 S10 的 `doctor`，只在繼承時才有意義。
  - env 白名單：engine 的 process 載入了 `.env`，裡面有 tracker 的 token，整包繼承會讓 agent 拿到它（違反 agent-contract.md 的第一條）。runner 只放行 `PATH`、`HOME`、`USER`、`LOGNAME`、`SHELL`、`TMPDIR`、`LANG`、`TERM`，加上 `TASUKI_*` 與 `options.env`。
  - session：runner 自己產生 uuid 用 `--session-id` 開新的，不用從輸出解析。`per-item` 時 engine 找這張 item 上同一個 agent 最近一個有 `sessionId` 的 Run，交給 runner `--resume`。claude 找不到 session 時 exit 1、stderr 是 `No conversation found with session ID`，runner 看到就改開新的，不算失敗。用到的 session 透過 `onSession` 記在 Run 上（`run.session_id`）。規則省略 `session` 時是 `fresh`。
  - log：stdout 與 stderr 寫進 `<dataDir>/logs/<runId>.log`，每有輸出就 `onActivity`，engine 一秒最多寫一次 `lastActivityAt`。Run 沒有 verdict 或 exit code 不是 0 時，system comment 附 log 最後 20 行（最多 2000 字）。
  - `RunSpec` 多了 `prompt`、`resume`、`logPath`、`onActivity`、`onSession`。runner 是 callback 回報，不是 `RunHandle` 上的欄位，因為 resume 失敗改開新的時，session 會在 Run 中途換掉。
  - prompt：規則的 `prompt`、`promptFile` 與三個 mode 的預設 prompt 從 S12 拉進 S8，沒有 prompt 就不可能真的跑。預設 prompt 寫在 `packages/server/src/prompts.ts`，含 D30 的冪等準則（待釐清 6 的措辭）。
- 實測（2026-11-21，claude 2.1.323，sonnet，sqlite，玩具 repo `~/Test/tasuki-toy`）：split 一輪 9 秒、$0.06，拆成兩張有 blockedBy 的 task，facade 只掛 splitter 的六個 tool。第一次 execute 失敗：agent 把 `ls && git clone && cd && cat` 串成一條 Bash，`dontAsk` 要每一段都在白名單裡，整條被拒。agent 老實回報 `failed`、task 送回 `to-do`、留言說缺權限，失敗的路是通的。預設 prompt 因此補上一條：白名單外沒人會允許，讀改檔用檔案 tool，一次 shell 只跑一條指令。
- 還沒做：`runTimeoutMinutes` 與 `idleTimeoutMinutes`（卡住只能按 Stop）、`api-key` 與 `oauth-token` 的認證、看板上的 Run log 檢視、Run 記 pid 供 engine 重啟後清理（待釐清 7）。
- 重新檢視：agent 常因為 shell 指令被擋而失敗時（考慮內建一份預設的 `allowedTools`，或在 log 裡把 `permission_denials` 寫進失敗 comment）；做 codex runner 時，看 `RunSpec` 的 callback 夠不夠用。

## D77 prompt 分三層，agent 自帶 plugin 與 MCP

- 背景：agent 要能跑在兩種機器上，作者自己的筆電，和什麼都沒裝的 VM。D76 的預設隔離讓兩邊結果一樣，但隔離之後 agent 用不到作者的 skill（例如 sdd 的 `/propose`、`/apply`）。另外 D37 的寫法是 rule 一設 `prompt` 就整份換掉預設，連怎麼用 tasuki 的那段也一起不見，agent 不知道要呼叫 `report_result`，Run 必定 `failed`。
- 決定：
  - prompt 分三層：engine 契約（`CONTRACT`，永遠排在最前面，使用者改不到）、agent 的基礎層（claude 的 `appendSystemPrompt` / `appendSystemPromptFile`，走 `--append-system-prompt`）、規則的行動層（`prompt` / `promptFile`，省略時用 mode 的預設）。D37 的「省略時用預設」現在只指行動層。
  - 契約是程式規則的說明書。status、verdict 驗證、`RUN_CANCELLED` 都由程式擋，但呼叫 `report_result` 只能靠文字告訴 agent。
  - claude-cli 的 options 加 `plugins`（`--plugin-dir`）與 `mcpServers`（跟 tasuki 併進同一份 `--mcp-config`）。隔離時照樣載入，所以同一份 config 在 VM 上跑得一樣。額外 MCP server 的 tool 一樣要寫進 `allowedTools`，不自動放行（D35）。
  - 每個階段要不同的 plugin、MCP 或基礎層，就開不同的 agent，規則指過去。runner 專屬的東西留在 agent 上，規則不長出 claude 才有的欄位，之後接 codex 不用動規則。
  - push、propose 的產物怎麼處理、做完留什麼 comment，都是 prompt 的事，engine 不碰 git（workspace-and-git.md）。
  - `PluginContext` 加 `configDir`，plugin 的 options 裡的相對路徑對它解析，跟 config 其他路徑一致。
- 實測（2026-11-21，claude 2.1.323，sonnet，sqlite，玩具 repo 加一個 bare remote）：split 規則的 agent 載入 `eli-marketplace/plugins/sdd`，基礎層寫「沒有 clone 就 clone 到 cwd、開 `feature/<ref>`、做完 commit 加 push」，行動層寫「跑 `/sdd:propose`，依 tasks.md 拆：能一路 apply 完的併成一張，要人決定的拆成 manual」。一輪 37 秒、$0.25、22 turns、沒有任何 tool 被擋。agent clone 進 workspace、開 branch、`/sdd:propose` 寫出 proposal、design、spec、tasks 四份檔，判斷可以一次 apply 完，只開一張 task（body 寫著 `Run /sdd:apply add-farewell`），commit 加 push 到 remote，留 comment 說明拆法與假設，item 到 `split-review`。init 訊息確認隔離還在：只載入 sdd，作者裝的其他 plugin 都沒有。這也驗證了 headless 底下 skill 叫得起來（agent 用 `Skill` tool 呼叫 `sdd:propose`），plan.md 待驗證的那條因此移除。
- 注意：commit 帶著 Claude Code 內建的 `Co-Authored-By` 行，`--setting-sources ""` 不會拿掉它。不要的話寫進基礎層，或之後給 agent 一個 `settings` option。
- 重新檢視：基礎層需要跨 agent 共用很多份時（考慮在 agent 之外加一個共用的基礎層）；codex runner 沒有對應 `--append-system-prompt` 的東西時，基礎層改成接在契約後面。

## D78 流程可以自訂，設定進 DB，store 也是 plugin

- 背景：每個人、每個團隊的 stage 都不一樣，tasuki 要主打彈性。現在 item 的 status 寫死十個、verdict 寫死五個、config 只能寫在檔案裡，runtime store 寫死是 sqlite。作者要同時支援自己一台機器用，和部署在共用機器上大家一起用，之後還要接 postgres 等其他 DB，並讓第三方照介面自己寫 DB 的 plugin。
- 決定（細節在 custom-workflow.md）：
  - stage 分三種：靜態、等人（看板標眼睛，status 的 `waitsFor: "human"`）、engine（標雷達，有規則 watch 就是）。是 D68 的一般化。
  - item 的 status 由使用者列，程式點名的五站改成角色：`entry`、`done`、`failure`、`taskReview`、`rework`。task 的 status 維持寫死。六條不變量不變。
  - 規則宣告 `outcomes`（結果名到下一站），`on` 併進來。每個 mode 都能宣告額外的結果，內建結果的驗證不變。agent 只能回結果名，不能回站名。
  - `mode` 留著當工具組，多一個只能讀與留 comment 的 `review`。
  - 流程設定（status、角色、規則、agent、prompt、status 對照）放 store，前端能改，下一輪 poll 生效，每次修改留歷史。啟動設定（store 的 plugin 與連線、`dataDir`、`server`、`auth`、tracker）留在檔案。secret 一律在環境變數，DB 只存 `${VAR}`。不做匯出匯入。
  - store 變成 plugin 的一個角色，跟 tracker 一樣有 `testkit` 契約，migration 由 plugin 自己帶。內建的 sqlite 是第一個。
  - 切片：W1、W2、W3 排在 S9 之前，W4（設定頁）在 S9 之後，postgres 之後再排。W1、W2 先在檔案上定型，搬進 DB 時才不會每改一次設計就多一次 migration。
- 取代：D68 寫死的 `AWAITING_PERSON` 清單改成每個 status 的 `waitsFor`。D51 的「看板順序照 state-machine.md」改成照使用者列的順序。D37 第 3 點的 `on.failed`、`on.max_attempts` 改成 `outcomes` 底下的同名結果，預設仍是 `failure` 角色那一站。state-machine.md 那十站從定案改成預設流程，等 W1、W2 做完時一併改寫它與 config-and-rules.md。
- 重新檢視：角色不夠用時（又有程式需要點名某一站）；store 契約大到第三方寫不動時；共用部署需要多個團隊各自一套流程時（現在一個 engine 一套）。

## D79 看板的外觀：靛藍、亮暗切換、agent 在跑的卡片有繞圈的光

- 背景：作者覺得畫面太制式，像套版網站。要有質感、亮暗模式能切換、帶一點動效。
- 決定：
  - 配色：白天是偏冷的紙色加靛藍，晚上是靛藍夜色，token 寫在 `web/src/assets/main.css`，蓋過 Nuxt UI 的 `--ui-*` 變數。黃色只留給 logo 那一撇（襷，接力賽斜掛的帶子），favicon 用同一個形狀。
  - 字型：Bricolage Grotesque，`@fontsource-variable` 的 `standard.css`（粗細與寬度兩軸），打包進 bundle。
  - 亮暗切換：開 Nuxt UI 的 `colorMode`（VueUse `useDark`），按鈕自己寫，讀寫同一個 localStorage key `vueuse-color-scheme`，切換時用 View Transition 從按鈕的位置圓形展開。
  - agent 在跑的卡片：卡片外面一直有一圈 1.5px 的框，墊在卡片後面，所以圓角跟直邊一樣粗。agent 在跑時框上有一段靛藍光繞圈，三秒一圈；Stopping 時變灰。作者在 demo 上比過條紋、底線、掃光、呼吸與五種顏色後選的。條紋太吵、又蓋到字，左邊加一道色邊會跟外框打架。
  - 卡片移到新欄時輕輕落下（`TransitionGroup`）。系統開了減少動態時，三種動效都關掉，跑中的卡片改成靜止的靛藍框。
  - 詳情：標題列縮成一行（ref 加 status 標籤），下面分兩欄，左邊 Tasks 與 Comments，右邊附件與 Runs，窄螢幕時右欄排到上面。附件每個都是同一種列，圖片是縮圖，點了在同一頁放大。原生的檔案選擇器藏起來，換成按鈕，因為它會照系統語言顯示中文。依賴寫成 `Waits for TSK-5 Prepare`，帶 ref。下拉選單貼齊按鈕右邊。
- 重新檢視：W4 的設定頁、S9 的登入頁做出來時，照同一套 token；繞圈的光如果在很多張卡同時跑時太吵，改成只有滑鼠移上去才繞。

## D80 刪除附件，body 還在用就擋下來

- 背景：S3 只做了新增與讀取附件，作者試用 D79 的新畫面時發現傳錯檔刪不掉。
- 決定：
  - `StoragePort` 加 `deleteAttachment(target, id)`，id 不屬於 target 時丟 `NotFound`，不動 version。sqlite 刪那一列；Jira 先確認附件掛在這張 issue 上（`DELETE /attachment/{id}` 收任何 id），再刪。契約測試加一條，KAN 上實測過。
  - use case `deleteAttachment`：body 裡還有 `](attachment:<id>)` 時拒絕（`InvalidInput`，REST 400），訊息說是哪個檔案，請人先從 body 拿掉。刪掉後留一則人的 `system` comment「Deleted attachment x.png.」（D74 的人的操作紀錄），因為刪了就收不回來。
  - 看板與使用者 MCP 走同一個 use case（D57）：`DELETE /api/items/:ref/attachments/:id`、`delete_attachment`。
  - 畫面：附件那一列有垃圾桶，點了先問（Keep / Delete），錯誤顯示在附件清單下面，不在詳情最上面。
- 沒選的：照刪留下破圖（人不知道 body 為什麼壞了）；刪附件時一起把 body 裡的引用拿掉（偷改人寫的內容）。作者讓小夏挑，選了擋下來。
- 已知限制：只檢查附件所屬那張 unit 的 body。comment 的 markdown 也會把 `attachment:<id>` 畫成圖，但畫面上沒有插入附件到 comment 的方法，所以不檢查。
- 重新檢視：comment 能插入附件時，檢查要擴大到 comment。

## D81 W1：status 自訂，角色、`handledBy`、站上的 `outcomes`

- 背景：照 D78 做 W1。custom-workflow.md 只定了概念，沒寫 config 長什麼樣子，也沒處理詳情裡寫死站名的決定按鈕（`split-review` 的 Send back / Approve、`in-review` 的 Rework / Accept）。作者說還沒人在用，結構可以大改、不顧兼容。
- 決定：
  - config 的頂層 `statuses` 拿掉，換成 `workflow`：`statuses` 是一個陣列，順序就是看板的順序，每站是 `id`（邏輯名，kebab-case）、`name`（省略時是 id 的 Title Case）、`key`（tracker 的 status，省略時是 name）、`handledBy`、`outcomes`；`roles` 是一個 map，指出五個角色各是哪一站（D86 減成 `entry`、`failure` 兩個）；`taskStatuses` 是 task 五個 status 的對照。舊寫法啟動就報錯，叫人搬進 `workflow`（D85 拿掉這句專門的錯誤，改成不讀）。省略 `workflow` 時是預設十站。
  - 角色放 map 不寫在站上：map 天生一個角色只有一個值，不用另外驗重複。
  - D78 的 `waitsFor: "human"` 改名 `handledBy: "person"`，看板 API 的 `turn` 也改名 `handledBy`，從 config 到畫面同一個詞。作者覺得 turn 像回合制遊戲，要的語意是「這站誰處理」。`engine` 不給手寫，有規則 watch 才是，手寫的雷達會在沒規則時說謊（D68）。`assignee` 會撞 Jira 的欄位，`owner` 像在講誰有權限改設定，都沒選。
  - 人的決定按鈕改成站上的 `outcomes`：按鈕字到下一站（D87 改成只列目標站），按下去就是移過去，不帶別的行為。跟 W2 規則上給 agent 的 `outcomes` 同名同形，一邊是 agent 的結論、一邊是人的結論。最後一個是實心的主按鈕。目標是 `rework` 角色那站時，照 D75 先問改什麼，這件事看目標站的角色，不看是哪顆按鈕。預設流程填好原本那四顆，字沒變。
  - 原本 `split-review` 沒有 task 時 Approve 是灰的，這個條件拿掉：按鈕是通用的，放不了這種條件；execute 底下沒有 task 時 `succeeded` 照字面成立（D69），最多空跑一次。
  - 規則沒寫 `on.failed`、`on.max_attempts` 時，讀 config 就填成 `failure` 那站，core 的 `exitFor` 不再寫死 `blocked`。W2 把 `on` 併進 `outcomes` 時照搬。
  - use case 只收它要的角色：`createItem` 收 `entry`，`updateTask`、`deleteTask` 收 `taskReview`（沒有就一律拒絕），`requestRework` 收 `rework`（沒有就拒絕）。`listBoard` 改收整份 workflow，回傳每欄的 `outcomes` 與整個 `roles`。使用者 MCP 的 tool 說明照角色填站名，不再寫死 `refining`、`split-review`、`ready-to-rework`（D57）。
  - tracker plugin 不變：config 從每站的 `key` 算出原本那份 `StatusMapping` 交給它。
  - E2E：兩組都在預設十站後面多一站 `triage`（`handledBy: "person"`，一顆 Send to split），新的一條驗它成為一欄、眼睛與雷達標對、按鈕把 item 送進下一站。
  - KAN 的設定（2026-11-21）：照 D59 的方法用 `POST /rest/api/3/workflows/update` 加了 `Triage`（`10013`，category TODO）與一條 GLOBAL 轉移，workflow 從版本 6 變 7。`.env` 的 `JIRA_TEST_ITEM_STATUSES` 多一個 `triage`。
- 已知限制：`done` 角色必填、會出現在看板的 `roles` 裡，但目前沒有程式依它做事。站上的按鈕放在詳情 Tasks 標題的右邊，沒有 task 的自訂站也一樣放在那裡。
- 取代：D68 的 `turn`（改名 `handledBy`）與寫死的 `AWAITING_PERSON`；D78 的 `waitsFor`；D51「看板只顯示有對照的 status」改成只顯示 `workflow.statuses` 列出的；config-and-rules.md 原本的頂層 `statuses`。
- 重新檢視：又有程式需要點名某一站時（加角色前先看能不能用 `outcomes` 或 `handledBy` 表達）；自訂站要有 task 以外的地方放按鈕時；`done` 角色一直沒有用途時，考慮拿掉必填。

## D82 看得出從哪站到哪站：按鈕、comment、Run

- 背景：作者試用 W1 時發現兩件事。一是預設流程的按鈕字還是 Approve and start、Accept as done 這種寫死的動作，跟 D81 說的「按鈕只是下一步」對不上。二是 comment 跟 Runs 看不出 item 從哪站到哪站：engine 的 comment 只寫 `moved to split-review`，人移動的那則用邏輯名，Runs 完全沒有。作者也要求 status 這類固定的字要有明顯的標示。
- 決定：
  - 預設流程的按鈕字改成「箭頭加目標站的顯示名」：`→ Refining`、`→ In Progress`、`→ Ready to Rework`、`→ Done`。只寫站名會跟旁邊 task 的 status 標籤混在一起，箭頭讓人一看就知道是移過去。
  - 所有寫進 comment 的 status 改成粗體的顯示名，移動一律寫成 `**From** → **To**`。規則名與 outcome 用 code 樣式。comment 存在 tracker，粗體與 code 是 markdown，Jira 上也看得到。core 加 `StatusNames`（`itemStatusNames(workflow)`、`taskStatusName`），engine 跑的五個 use case 從 deps 拿到它，`moveItem`、`requestRework` 改收整份 workflow（D81 加的 `rework` 參數因此拿掉）。task 的顯示名是固定的，core 直接用。
  - Run 多存 `from`（被認領時 item 待的 status，就是規則的 watch）與 `to`（engine 結束時把 item 移去的地方，cancelled、abandoned 不填）。在寫入的那一刻存，因為 W4 之後規則能在網頁上改，事後算不回來。runtime store 加 `from_status`、`to_status` 兩欄，舊的 Run 兩欄都是空的，畫面上不顯示。
  - 詳情的 Runs 每列多一行 `From → To`，兩邊都是跟標題列同款的 status 標籤，規則名用等寬字。
- 順手修的：詳情標題列的 ref 跟關閉鈕沒對齊。description 那格雖然只放 `sr-only` 的字，外面的 `<p>` 還是佔了一行，把 ref 往上推。改成整格 `sr-only`，關閉鈕從 `top-2` 改 `top-1.5`，量過三者的中心點在同一條線上。
- 取代：D81「預設流程填好原本那四顆，字沒變」。
- 重新檢視：comment 要支援非英文的顯示名或多語系時；Runs 要顯示更多過程（例如中間經過 claim status）時。

## D83 Jira 的 E2E 開跑前清空測試 project

- 背景：KAN 同時是 E2E 與作者手動試用的地方。E2E 只在跑完時刪自己建的 item，跑之前不清，而 engine 會撿整個 project 裡在 watch status 的 item。手動留下的 `[fake:hang]` 會永遠佔住一個 Run 名額；作者在測試跑的時候動到看板上的卡，engine 照 D72 把 Run 當成「人移走了」取消，測試就等不到結果。2026-11-21 一次整套重跑就這樣掛了一條。
- 決定：`playwright.config.ts` 載入時，若這次要跑 `jira` project，先用 JQL 找出 `JIRA_TEST_PROJECT` 裡所有 item 型別的 issue，連同 sub-task 刪掉。放在 config 載入時而不是 globalSetup，因為要比 webServer 早，engine 起來之前沒有剩下的卡可撿。worker 會重新載入 config，所以用 `TASUKI_E2E_JIRA_EMPTIED` 擋住，只在主 process 跑一次。只跑 `--project sqlite` 時不碰 KAN。
- 實測：在 KAN 建一張 `leftover [fake:hang]`，`--project sqlite --list` 之後還在，`--project jira --list` 之後沒了；之後整套 Jira E2E 11 條全過。
- 沒選的：E2E 換一個獨立的 Jira project（最乾淨，但要再設一套 project、status 與 workflow）。
- 代價：手動放在 KAN 上的卡，跑一次 Jira E2E 就沒了。契約測試沒有清空，它只讀自己建的 item。
- 重新檢視：KAN 開始放要留著的資料時（改成獨立的 E2E project）。


## D84 W2：規則宣告 `outcomes`、`review` mode

- 背景：照 D78 與 custom-workflow.md 第 3、4 節做 W2。原本 agent 只能回四個固定的 verdict，engine 查規則的 `on` 決定去哪，使用者沒辦法加一站「AI 看一看、給結論」。
- 決定：
  - 規則的 `on` 改名 `outcomes`，key 是結果名（小寫加底線），值是目標站。舊的 `on` 讀檔就報錯叫人改，不轉換（D85 拿掉這句專門的錯誤，改成不讀）。custom-workflow.md 原本寫「讀進來時轉換」，作者改成上線前一律不顧兼容（2026-11-21，寫進 CLAUDE.md）。
  - 結果分三種。mode 自己的必填、engine 會驗：split、rework 是 `succeeded`，execute 是 `succeeded` 與 `blocked_manual`，review 沒有。每條規則都有的 `needs_input`、`failed`、`max_attempts` 可省略，省略時跟 D81 的 `failed` 一樣填成 `failure` 那站；以前 `needs_input` 是必填，作者決定照同一招處理（2026-11-21）。其他名字是規則自己宣告的，不驗，照表搬。每條規則至少要有一個不屬於第二種的結果，不然 agent 只能失敗。
  - `report_result` 的欄位還是叫 `verdict`，但 enum 每個 Run 照規則產生（`max_attempts` 以外的結果名）。facade 與 `reportResult` use case 都擋選項以外的值，item 內文叫 agent 回 `done` 這類站名也只會被拒絕。facade 從 run token 找到 Run 的規則，整條規則交進去，不再只給 mode。
  - 新的 `review` mode：只有 `get_item`、`list_tasks`、`list_comments`、`add_comment`、`report_result`。`create_task` 原本是「不是 execute 就掛」，改成只有 split 與 rework 掛，不然 review 會拿到建 task 的權限。預設 prompt 叫 agent 留一則 note 再選結論。
  - core 的 `Verdict`、`Outcome` 變成 `string`，`VERDICTS` 拿掉，改成 `MODE_OUTCOMES`、`ENGINE_OUTCOMES` 與 `verdictsOf(rule)`。`refuse` 只驗 mode 自己的結果與 `needs_input`。
  - runtime store 的 `run.outcome`、`run.verdict` 拿掉 CHECK，跟 S7d 一樣重建表（建新表、複製、刪舊、改名），驗證交給 config。
  - fake runner 從 `tools/list` 讀 `report_result` 的 enum，跟真的 agent 一樣。`[fake:<名字>]` 只在規則有這個結果時才用；review 時留一則 note，沒有標記就回規則的第一個結果。
  - E2E：兩組都多一站 `ai-review`（顯示名 `AI Review`）與一條 review 規則，`approve` 去 `in-review`，`changes` 去 `ready-to-rework`。新的一條驗沒有標記的 item 走到 In Review，Run 列出 `AI Review → In Review`，有 agent 的 note。`[fake:changes]` 那張之後會被 rework 規則接手（沒有人寫回饋，D74），所以改看它 Run 的 `to`。
  - KAN 的設定（2026-11-22）：照 D59 的方法用 `POST /rest/api/3/workflows/update` 加了 `AI Review`（`10014`，category IN_PROGRESS）與一條 GLOBAL 轉移，workflow 從版本 7 變 8。`.env` 的 `JIRA_TEST_ITEM_STATUSES` 多一個 `ai-review`。
- 實測：`pnpm test` 343 條、`pnpm check` 沒有錯誤與警告；`pnpm e2e` 的 sqlite 與 jira 各 12 條全過（分開跑）。
- 沒選的：自訂結果也讓使用者寫驗證條件（例如 `approve` 要有一則 note）。驗證擋的是謊報完成，自訂結果被亂用時 item 也只會去使用者自己指定的站，風險跟亂回 `failed` 同級（custom-workflow.md 第 3 節）。
- 重新檢視：有人需要自訂結果的驗證時；`report_result` 要回傳多個結論或帶參數時；W4 熱重載後，進行中的 Run 規則被改掉、結果名對不上時。


## D85 不為舊寫法寫專門的錯誤訊息

- 背景：D81 與 D84 各留了一句只為舊 config 存在的錯誤：頂層 `statuses` 報「moved into workflow」，規則的 `on` 報「moved into outcomes」。作者問這是不是特別設計的，認為上線前不顧兼容也包括不替舊寫法指路（2026-11-22）。
- 決定：兩句都拿掉，CLAUDE.md 的「舊寫法報錯叫人改」改成不寫專門偵測舊寫法的錯誤。config 照舊不檢查多出來的 key。
  - 規則寫 `on` 沒寫 `outcomes`：`on` 被略過，撞到 mode 必填的 `outcomes.succeeded`；review 規則撞到「至少要有一個 agent 能完成的結果」。還是起不來，只是訊息不說它搬去哪。
  - 頂層 `statuses`：被略過，沒寫 `workflow` 時用預設十站，key 是顯示名。sqlite 照跑；接 Jira 時 key 要對得上 Jira 的 status，對不上不會在啟動時被擋。
- 掃過的地方：`packages/*/src` 的 config 解析、migration（只有重建表時的整表複製，沒有轉換舊資料）、MCP 與 API 的參數，沒有別的專門處理舊寫法的分支。
- 重新檢視：上線之後改 config 欄位時；決定 config 要拒絕不認得的 key 時（那時舊寫法會自然報錯）。


## D86 角色只留 `entry` 與 `failure`，改 task 看有沒有 agent 在跑

- 背景：作者看 config 的 `roles` 時問，除了新 item 去哪、失敗去哪，其他角色真的需要嗎（2026-11-22）。對過程式碼：`done` 沒有任何程式在讀（D81 的已知限制）；`taskReview` 與 `rework` 不是出口，是站的行為，一個管人能不能改 task，一個管打回要不要先寫回饋。
- 決定：
  - `done` 拿掉。看板照 `workflow.statuses` 的順序畫，不需要終點。
  - `taskReview` 拿掉，人改、刪 task 的條件從「item 在這站」改成「item 沒有存活的 Run」，有的話 `InvalidInput` 叫人先 Stop。作者的提法：有 agent 在跑就不能直接改，要先停。D70 沒選「任何時候都能改」的理由是會跟 orchestrator 讀到的內容打架，有 Run 就擋正好避開。`updateTask`、`deleteTask` 跟 `deleteItem` 一樣收 `{ storage, runtime }`。看板的 Edit、Delete task 一律顯示，最新的 Run 還在跑時灰掉，提示 Stop the agent first。
  - `rework` 不給手寫，讀 config 時從 mode 是 `rework` 的規則 `watch` 的那站算出來，填進 `workflow.roles.rework`，下游（看板、`requestRework`、使用者 MCP）照舊讀它。打回時寫的回饋就是給那條規則的 agent 讀的，兩件事本來就綁在一起。rework 規則有好幾條時要盯同一站，不然讀檔拒絕。沒有 rework 規則就沒有這個值，`request_rework` 照舊拒絕。
- 理由：前台少寫三個欄位，config 只剩一眼看得懂的兩個。後台少一個必填驗證與兩個條件驗證，多一個「rework 規則盯同一站」的驗證。`blocked` 時也能改 task，改完讓它自動接回，不用打回重拆。
- 已知限制：檢查「沒有 Run」與真的寫入之間，engine 可能剛好 claim 了這張 item。改內容帶 version，會撞出 409；刪除不帶 version，agent 之後讀不到那張 task，`set_task_status` 拿到 NotFound。跟人直接在 Jira 上刪 task 一樣，agent-contract 本來就要 agent 以 tracker 現況為準。
- 取代：D70 的「只在 `split-review` 改 task」、D81 的五個角色。
- 實測：`pnpm test` 341 條、`vp check` 與全部 typecheck 沒有錯誤。
- 重新檢視：又有程式需要點名某一站時（先看能不能從規則算）；有人要在 agent 跑的時候讓人改 task 時。


## D87 站上的 `outcomes` 只列目標站

- 背景：作者看 config 時發現站上 `outcomes` 的 key 是 `→ Refining` 這種畫面上的字，config 應該寫規格（2026-11-22）。D82 已經把按鈕字定成「箭頭加目標站的顯示名」，key 從 value 就算得出來，等於同一件事寫兩次。
- 決定：
  - 站上的 `outcomes` 從「按鈕字到站」的 map 改成目標站的陣列，例如 `["refining", "in-progress"]`。陣列的順序就是按鈕的順序，最後一個是主按鈕，不再靠 object key 的順序。同一站列兩次讀檔拒絕。
  - 按鈕字由看板組：`→` 加目標站的顯示名。`Station.outcomes`、看板 API 每欄的 `outcomes` 都變成 `string[]`，使用者 MCP 的 `list_board` 說明跟著改。
  - 欄位名照舊叫 `outcomes`（作者決定）：意思還是人在這站能得出哪些結論，只是寫法從 map 變陣列。
- 沒選的：學規則取結果名（`{ "send_back": "refining" }`）。人按按鈕不需要 verdict，按了就是移過去，多一層名字只是翻譯。
- 取代：D81「人的決定按鈕改成站上的 `outcomes`：按鈕字到下一站」的寫法；按鈕不能再自訂文字。
- 實測：`pnpm test` 343 條、`vp check` 與全部 typecheck 沒有錯誤，sqlite E2E 12 條全過。
- 重新檢視：有人需要按鈕寫目標站以外的字時（例如多語系）。

## D88 store 是 plugin 角色，port 改名 `TrackerPort` 與 `StorePort`

- 背景：W3，照 D78 把 store 從 `server` 搬成 plugin 的一個角色（2026-11-22）。
- 決定：
  - `RuntimeStorePort` 改名 `StorePort`，`StoragePort` 改名 `TrackerPort`，use case 的依賴欄位跟著從 `storage`、`runtime` 改成 `tracker`、`store`。不改的話 `StorePort` 跟 `StoragePort` 只差三個字母，一定會看錯；保留 `RuntimeStorePort` 的話，W4 把流程設定放進來就名不副實（作者選的）。testkit 的 `describeStorageContract` 改名 `describeTrackerContract`。
  - `Plugin` 多一個 `store` 工廠，config 多一個 `store`（`plugin` 加 `options`），省略時是 `@tasuki/sqlite`，跟 `tracker` 一樣。
  - `@tasuki/sqlite` 同時提供 tracker 與 store，store 開 `<dataDir>/store.db`，migration 帶在 plugin 裡（`store-migrations.ts`），server 那份重複的開 DB 加 migration 的小程式刪掉。檔名從 `runtime.db` 改成 `store.db`，不寫轉換（D45 之後不顧兼容）；migration 鏈原封不動，舊檔改名就接得上。
  - Run 的 log 檔由 engine 命名（`<dataDir>/logs/<runId>.log`），不再由 store 決定。log 是 engine 那台機器上的檔案，換成遠端的 store 時它看不到那個資料夾。`Run.logPath` 拿掉，`run.log_path` 用一條 migration `DROP COLUMN`，engine 多一個 `logDir` 依賴。
  - testkit 多一套 `describeStoreContract`：setup 每條測試給一個空的 store 與契約控制的 clock，涵蓋一張 item 一個存活的 Run、lease、取消的升級規則、結果只收第一次、最新在前的排序（同一毫秒也一樣）、`latestRunsEndedIn`、暫停旗標。sqlite 通過。
  - `/api/health` 只回 `{ ok: true }`。schema 版本是 sqlite 的細節，web 早就不顯示，只剩 E2E 拿它確認 server 起來了。
- 後果：D44 的「Jira 模式下 `sqlite` 套件不是必裝」不再成立，除非換成別的 store plugin。plugins.md「RuntimeStore 不是 plugin」那條拿掉。
- 沒做的：custom-workflow.md 驗收條件 6 的「假 store plugin 換掉 sqlite、engine 照常跑」。契約已經讓第二個實作有東西可以對，真的第二個實作等 postgres。
- 實測：`pnpm test` 353 條、`pnpm check` 沒有錯誤，`pnpm e2e` sqlite 與 jira 共 24 條全過。故意把排序的 `rowid DESC` 改成 `ASC`，store 契約有兩條會紅。
- 重新檢視：W4 把流程設定加進 `StorePort` 時，看契約會不會大到第三方寫不動（D78 的重新檢視條件）。

## D89 身分與權限分開，三種 access

- 背景：S9 動工前討論（2026-11-22）。作者要部署給公司用，希望有人能在網頁上管帳號、管流程設定，D60 的「登入就有完整權限」不夠。
- 決定：
  - auth plugin 只回答身分（`userId`、`displayName`）。access 存在 store，用 `userId` 對，不管帳號是誰管的，指派都在看板上做。
  - access 三種：`admin` 管帳號、改設定、用系統；`maintainer` 改設定、用系統；`member` 只用系統。設定頁在 W4，在那之前 `maintainer` 與 `member` 實際上一樣。命名跟 workflow 的 role 分開，叫 access。
  - 內建兩個 auth plugin：`@tasuki/auth-builtin`（帳號與 scrypt 密碼 hash 在 store，admin 在看板上建帳號）與 `@tasuki/auth-http`（登入頁的帳密轉給外部 API）。不登入是省略 `auth`，每個請求當成 `admin`。`static` 拿掉。config 跟其他角色一樣寫 `plugin` 加 `options`，`auth.kind` 拿掉。
  - 外部帳號第一次登入建成 `member`（D90 改：admin 先加才能登入）。停用的帳號 session 與 token 立刻失效；外部帳號只能停用（D90 改：都能刪）。最後一個 `admin` 不能降級或停用。
  - 第一個 admin 用 setup token：store 沒有啟用中的 `admin` 時，啟動 log 印一次性 token，builtin 用它建第一個帳號，http 登入後用它升級自己（D90 改：token 加外部帳密直接建）。token 只在記憶體，有 admin 就作廢。
  - session ttl 預設 7 天。session 記著發出時的 ttl，跟現在的設定不同就失效，所以改 ttl 會讓之前的 cookie 全部失效。
  - 防暴力：同一個帳號連錯 5 次以內不延遲，第 6 次起 1 秒、2 秒、4 秒加倍到 30 秒。
  - S9 拆成 S9a（builtin、access、帳號管理、session、CSRF、`Host`、防暴力、個人 API token）與 S9c（http、開放非 loopback）。原本的 S9b（API token）併進 S9a：作者平常用 Claude Code 接 `/mcp`，設了 auth 卻還沒有 token 的話 `/mcp` 整個 401。
  - 實作時定的：setup token 除了印在 log，也寫進 `<dataDir>/setup-token`（像 Jenkins），E2E 與 container 都讀得到。`Secure` cookie 只在 https 時加。管帳號與 API token 只在看板，不進使用者 MCP（D57 的例外，密碼不該進 AI 的對話紀錄）。Jira 上人寫的 comment 把登入者的名字放進 comment property。密碼至少 8 個字元、不設組合規則；NIST SP 800-63B-4 對只有密碼的登入要求 15 個字元，作者試用後選擇維持 8。builtin 的帳號不另設顯示名，看到的就是帳號名，少一格表單也不會有「改不了名字」的問題；外部帳號照用外部系統給的顯示名（員編與真名常常不同）。
  - 人的名字不是一個個 use case 傳進去的：server 每個登入的請求用 `AsyncLocalStorage` 記著是誰，交給 use case 的 tracker 包一層，`human` 的 comment 自動帶上 `authorName`。use case 不用改簽名，engine 自己寫的 comment 跑在請求外，不會被蓋上名字。
  - `Host` 與 `Origin` 檢查不登入時也做，DNS rebinding 與跨站 `POST` 在不登入時最危險。`auth-builtin` 的工廠多拿到 `store`（`AuthContext`）。
- 理由：
  - 身分跟權限分開，換 auth plugin（以後的 OIDC、LDAP）不用碰權限；帳號放 store，接自己的 DB 就是換 store plugin（D88）。
  - `static` 把帳號寫在 config，又在網頁上管 access，兩邊會打架。builtin 取代它，也就不需要產生 hash 的 CLI。
  - 叫 `builtin` 不叫 `local`：業界較常用 local，但字面容易讀成「本機」，跟不登入的本機用途混在一起（作者選的）。外部的以協定命名，名字本身就代表外部。
  - 第一個 admin 不讓「第一個打開網頁的人」當，綁在非 loopback 時誰先搶到就是誰的；不用 CLI，container 看 log 比 exec 進去容易。
  - `auth-http` 不是 SSO，密碼會經過 tasuki。作者的公司情境是登入頁打公司帳密、tasuki 去問公司的 API，所以先做它；公司只開 OIDC 時另做 plugin。
  - 改 ttl 要在驗證時比對而不是啟動時清，因為 W4 之後 ttl 會在執行中被改。
- 實測：`pnpm test` 387 條、`pnpm check` 沒有錯誤，`pnpm e2e` sqlite、jira、auth 共 25 條全過。把「5 次不延遲」改成 4、把「ttl 不同就失效」拿掉，server 測試各有一條會紅。
- 重新檢視：需要比 `member` 更小的權限（唯讀、只看部分 item）時；公司只提供 OIDC 或 SAML 時；W4 做設定頁時確認 `maintainer` 能改的範圍。

## D90 外部帳號要先加、帳號可刪、`auth-http` 的 options、`allowInsecure` 的範圍、setup 連結

- 背景：S9c 動工前與實作中（2026-11-22）。作者問過能不能拿掉 setup token、讓第一個打開網頁的人直接建 admin，討論後維持 D89。做完後作者指出帳號應該能刪，外部帳號也一樣：加進來這個動作就是同意他登入，外部系統對誰都會說帳密對。
- 決定：
  - 推翻 D89 的「外部帳號第一次登入建成 `member`」：外部帳號要 `admin` 先用 username 加進來，名單上沒有的人登入跟密碼錯一樣。帳號頁可以一次貼一串 username，一行一個，統一一個 access，已經在的跳過並列出。
  - 第一次登入把外部的 `userId` 綁到帳號的 `external_id`，之後用它找人；已經綁定的 username 換成另一個外部 `userId` 就進不來。tasuki 自己的 `userId` 由 store 產生。
  - 兩種模式的帳號都能刪，連同 session 與個人 API token。自己不能刪自己，最後一個啟用中的 `admin` 不能刪。comment 上的名字是寫入時複製的，刪了照樣顯示。
  - 第一個 admin 兩種模式都在登入頁一次填 token、username、密碼；http 把帳密交給外部系統驗，通過就建成 `admin`。名單一開始是空的，原本「先登入再升級」走不通。
  - 加人不進使用者 MCP，維持 D57 的例外。帳號頁加篩選框；帳號列表與看板都沒有虛擬滾動。
  - 按了之後的回饋出現在按的地方：列表裡的確認（刪帳號）展開在那一列底下，跟刪附件、重設密碼一樣；按鈕觸發的錯誤一律用 toast。對話框頂端的錯誤框只留給「載入失敗」。刪 item、刪 task 的確認照舊在頂端，因為它們的按鈕本來就在頂端（作者指出列表很長時，頂端的確認與錯誤要捲回去才看得到）。
  - `auth-http` 的 options：`url` 必填，`headers`、`timeoutSeconds`（預設 10）選填，一般人不用設。4xx 是帳密不對；5xx、逾時、連不上丟錯，登入回 500，不讓「驗證服務壞了」看起來像「密碼錯」。`displayName` 沒給就用 username，每次登入用外部的名字覆蓋 store 裡的。
  - `allowInsecure: true` 同時豁免「非 loopback 要 auth」與「非 loopback 要 https 的 `publicUrl`」。
  - 有 `publicUrl` 時，啟動 log 多印 `<publicUrl>/?setup=<token>`，登入頁自動帶入 token 再從網址列拿掉。
  - 綁單一個非 loopback 位址時，agent 用那個位址連 `/agent-mcp`，`Host` 檢查只對 `/agent-mcp` 多認它。
- 理由：
  - 留著 setup token：搶到 admin 的人可以建 item，規則一命中，agent 就帶著 Bash、git token 在那台機器上跑，發現時已經來不及。Gitea 讓第一個打開的人安裝，被搶只丟一個 git server；這裡丟的是一台會自己動手的機器。連結讓 token 的成本降到點一下。
  - `allowInsecure` 兩條都豁免：security-and-auth.md 的 Docker 範例是 container 綁 `0.0.0.0`、從 `http://localhost` 打開，照字面要求 https 的 `publicUrl`，那個範例根本起不來。兩條檢查保護的都是「網路上的人碰得到」，`allowInsecure` 本來就是使用者說「我知道，port 只開在本機」。
  - 只在有 `publicUrl` 時印連結：看板在 S12 之前由 vite 另外跑，engine 不知道它在哪個 port，印錯的網址比不印糟。
  - `/agent-mcp` 只多認綁定的位址，不讓看板也認：瀏覽器直接用 IP 打 http 會讓密碼走明文，繞過 proxy；agent 用 run token，跟瀏覽器無關。
  - 外部帳號先加：外部系統只回答帳密對不對，公司裡任何人都會通過；誰能用 tasuki 應該是 admin 決定的事。刪除因此等於從名單拿掉，不會像 D89 那樣刪了又自動建回來。
  - 綁 `external_id`：公司回收離職者的 username 再發給新人時，新人不會接到前一個人的 access。只用 username 對的話少一欄，但這個洞是靜默的。
  - 加人不走 MCP：外部帳號加人不用密碼，D57 例外原本的理由不成立，但使用者的 AI 會讀 item，item 是 prompt injection 的入口，AI 手上有加人與改 access 的 tool 就能被拿去開後門。貼一整欄 username 比叫 AI 加還快。
  - 不做虛擬滾動：幾百個帳號的 `<li>` 瀏覽器畫得動，難的是找人，所以加篩選框。看板 Done 欄只會越來越長，又有拖拉，另外處理。
- 實測：`pnpm test` 400 條、`pnpm check` 沒有錯誤，`pnpm e2e` sqlite、jira、auth、auth-http 共 26 條全過。把 `publicUrl` 的 host 從允許清單拿掉，server 測試會紅一條；拿掉「已綁定的 username 不能換人」的檢查，core 測試會紅一條。手動起 server：綁 `0.0.0.0` 沒有 auth 時拒絕啟動，有 auth 與 `publicUrl` 時印出連結、只認 `publicUrl` 的 `Host`。
- 重新檢視：S12 server 自己 serve 看板時，沒有 `publicUrl` 也能印連結；公司的驗證 API 不是 JSON 或不是 `POST` 時。

## D91 流程設定與啟動設定的分界，agent 留在檔案

- 背景：W4 動工前（2026-11-22）。修改 D78 的分界：D78 與 custom-workflow.md 原本把 agent 與 prompt 的三層都列進流程設定，第一次啟動時把檔案的 `workflow` 讀進 DB。作者要設定頁讓不寫程式的人也能改，問到 agent 放哪裡實際影響什麼。
- 決定：
  - 檔案只放啟動設定：`dataDir`、`server`、`auth`、`tracker`、`store`、`agents`、`poll`、`limits`、`workspace`。store 放流程設定：`workflow`（站、角色、`taskStatuses`）、`rules`、`labels`。分的方式是部署的人設、跟機器與程式行為有關的放檔案，團隊每天會想調的流程放 DB（作者選的）。
  - `agents` 留在檔案（作者選的）。規則的 `agent` 只能從檔案定義的名字裡挑。
  - 規則拿掉 `promptFile`，prompt 只是存在 store 的一段字。agent 的 `appendSystemPromptFile` 留著，因為 agent 還在檔案裡。
  - 檔案不再當流程設定的種子：檔案裡出現它不認識的欄位就拒絕啟動，`workflow`、`rules`、`labels` 也是（一般的欄位檢查，不是專為舊寫法寫的）。store 從沒存過時用預設流程：預設各站去掉 `splitting`、沒有規則，不寫進 store，第一次存檔才是第一版。E2E 開跑前用 API 存自己的流程設定。推翻 custom-workflow.md 原本的驗收條件 5。
  - 設定頁用表單，不是 JSON 編輯器（作者選的），只給 `admin` 與 `maintainer`。
  - 站的 key 在設定頁是 tracker 列出的 status 下拉選單。還有站的 key 不在 tracker 的 status 裡時（接 Jira 第一次啟動就是這樣），engine 不派 Run，看板頂端提示還有幾站沒對上並連到設定頁，不讓 engine 跑到轉移才失敗。
  - W4 拆成 W4a（進 store、設定頁、熱重載）與 W4b（修改歷史、回到任一版）。
  - 流程設定不進使用者 MCP，跟帳號一樣是 D57 的例外（作者選的）。
  - 存檔帶著讀到的版本號，中間有別人存過就 409，設定頁提示重新載入（作者選的）。store 把每一版都留著，W4b 的歷史直接用。
  - sqlite 的 status key 預設改成邏輯名，不再是顯示名（作者選的）。設定頁改顯示名不動資料；改邏輯名或拿掉一站時，上面還有 item 或 task 就拒絕存檔並列出來（custom-workflow.md 待釐清 5），Jira 改 key 也一樣。不寫轉換，本機舊的 sqlite tracker 資料要清掉。
  - 實作時定的：store 把流程設定當成不透明的 JSON 存，驗證在 engine，第三方 store 只要會存一段 JSON 與比對版本號。tracker 多一個選用的 `listStatuses`，有固定 status 清單的 tracker（Jira 用 `/project/{key}/statuses`，依 issue type 分）才提供，設定頁的 key 下拉選單與存檔檢查都靠它；sqlite 不提供，key 欄不顯示。檢查「還有沒有人在被拿掉的 status」時，跳過 tracker 本來就沒有的 key：那裡不會有人，Jira 也不接受搜尋不存在的 status，Jira 第一次存檔就是這樣。
  - 實作時定的：engine 每輪開始讀一次流程設定；Run 用開跑時的規則走完，規則跟著 run token 一起存在記憶體裡，`/agent-mcp` 從 token 拿規則，不再依名字去查現在的規則。看板與 API 每個請求讀一次，存完下一個請求就是新的。tracker plugin 拿到的 status 對照每次呼叫都讀現在那份，存檔後不用重建 tracker。
  - 設定頁當下就標出重複的站 ID、規則名與 Jira status，有重複就不能按 Save；server 照樣全檢查一遍，前端只是提早說。改一站的 ID 時，按鈕、角色與規則裡指向它的地方跟著改；ID 清空或撞到別站的那一下不搬，打完才搬，所以邊打邊改不會掉引用（作者 2026-11-22 要的）。
  - 實作時定的：store 裡存的設定跟檔案對不上時（規則用的 agent 在檔案裡改名或刪掉了）拒絕啟動，說明是哪一條，因為只有改檔案能修。站的顯示名預設（邏輯名的 Title Case）移到 core，設定頁與 server 用同一個。
- 理由：
  - agent 的 options 裡是 `allowedTools`、`plugins` 路徑、`env` 的 secret，決定 AI 在 engine 那台機器上能做什麼。放 DB 的話 maintainer 在網頁上點兩下就能開 `Bash(*)`，等於多一條提權的路。留在檔案，流程設定裡就沒有 secret 也沒有機器路徑，驗收條件 7 不用額外的遮罩邏輯。D78 的「DB 只存 `${VAR}`」因此用不到。
  - 每種 runner 的 options 不一樣，要做成表單就得要 runner plugin 描述自己的欄位，plugin 契約變大；不做表單就只剩 JSON 框，跟「不寫程式的人也能改」相反。
  - 檔案與 DB 各放一份流程，看的人要想現在以哪份為準。只留一個地方，DB 空的時候用內建預設，沒有這個問題。
  - `poll`、`limits` 是程式行為的數字，改錯會讓 engine 打爆 Jira 的 rate limit 或讓 lease 提早過期，屬於部署的人調的。
  - D89 寫的「W4 之後 ttl 會在執行中被改」不成立了，`auth` 留在檔案。驗證時比對 ttl 的做法不用改，重啟後改了 ttl 一樣要踢掉舊 session。
  - 代價：網頁上換不了 model、改不了基礎層 prompt。
- 實測：`pnpm test` 418 條、`pnpm check` 沒有錯誤，`pnpm e2e` sqlite、jira 各 15 條、auth、auth-http 共 32 條全過（多了兩個 project 開跑前存流程設定、設定頁加一站的主路徑，Jira 那條在 KAN 上挑 Manual，還有重複 ID 的即時提示與改 ID 帶著引用走，後者只在 sqlite，因為 KAN 只剩一個空的 status）。拿掉改 ID 時搬按鈕引用的那行，sqlite 的那條會紅。拿掉 sqlite store 的版本比對，store 契約會紅一條；拿掉「被拿掉的 status 上還有人」的檢查，core 與 server 各紅一條。Jira 的 `listStatuses` 對 KAN 實際跑過。E2E 途中抓到設定頁兩個問題並修掉：Reka UI 的選項不能用空字串當值，「不移動」「不用」改用 `_`；沒寫 `name` 的站被表單用 id 當顯示名存回去，改成跟 server 共用 core 的預設名。
- 重新檢視：有人需要在網頁上換 model 時，先考慮讓規則多一個 model 覆寫，不把整包 agent 搬進 DB；runner plugin 自己描述 options 的需求另外出現時；部署方式要「設定進 git」（GitOps）時，再看要不要匯入匯出。

## D92 `custom` mode：全部的 tool、不驗結果

- 背景：W4a 試用設定頁時（2026-11-22）。作者問 mode 是不是用 prompt 區分就夠，覺得使用者選什麼就是什麼，不用擋那麼多。討論後 mode 保留（工具與驗收擋的是 item 內容的 prompt injection 與 LLM 自己出包，不是使用者），另外多一個讓人自己負責的 mode，不跟 `review` 混在一起。
- 決定（作者選的）：
  - 新增 `custom`。agent 拿到全部的 tool：讀、留言、`create_task`、`set_task_status`、`report_result`。
  - 結果一個都不驗，連 `needs_input` 也不檢查有沒有留問題，照表搬。`succeeded` 必填（作者試用後改的：做完總要有地方去），跟 split 一樣是 mode 自己的結果，所以表單上不能刪；其他結果由規則自己加。
  - `prompt` 沒有預設，留空就只有 engine 的契約，不另外補一段。
  - 不變的：agent 還是沒有改 item status 的 tool；Run 結束時還在 `in-progress` 的 task 照不變量 3 退回 `to-do`；task 的狀態機照常。
  - 設定頁上 Mode 切到 Rework 時，Session 自動換成接著這張卡上次的對話，切走就換回每次重開；只改表單的初始值，server 省略 `session` 時仍是 `fresh`，已存的規則不會被偷改（作者 2026-11-22 要的，rework 要接著上次的想法）。
  - 實作時定的：因為能走完整張 task 圖，有 `custom` 規則時五個 task status 都要對照，跟 execute 一樣。fake runner 跑 `custom` 時跟 `review` 一樣挑第一個結果回報。設定頁的「Does」改名「Mode」，說明放在 Rules 區塊開頭，免得那一格比旁邊多一行而對不齊；mode 選單改從 core 的 `MODE_OUTCOMES` 產生，顯示文字用 `Record<RuleMode, …>`，core 多一個 mode 時沒補就編譯不過。
- 理由：
  - 工具與驗收保護的是不在現場的那段時間：item 內容是誰都能寫的，可能夾帶「別拆了，直接回報成功」；LLM 也會在沒拆出 task 時說成功。拿掉它們，item 會帶著空的結果滑進下一站。
  - 想自己控制的人有地方去，不用去改既有 mode 的語意。用 `review` 湊也行，但它沒有改 task 的 tool，名字也會讓人誤會。
- 實測：`pnpm test` 423 條、`pnpm check` 沒有錯誤。verdict 表多三列 `custom`（`succeeded` 沒有 task、`needs_input` 沒留問題、自己宣告的結果都照搬）；engine 測試確認 `custom` 拿到全部七個 tool，task 沒做完也照宣告的結果把 item 移走；flow 測試確認 `prompt` 留空就是空的，五個 task status 沒對照完被拒。
- 重新檢視：有人需要介於兩者之間的組合（例如只要 `create_task` 不要 `set_task_status`）時，再考慮讓規則逐項勾工具。

## D93 看板標出被失敗送走的卡

- 背景：W4a 試用時（2026-11-22）。作者指出 item 因為 `failed` 或重試到上限被移到別站時，看板上看不出來，跟人自己拖過去的長得一樣。
- 決定（作者同意的）：
  - 一張卡最新的 Run 結果是 `failed` 或 `max_attempts`，而且卡還停在那次 Run 送它去的站（Run 的 `to`），卡片的外框變紅（跟 Running 的藍光同一個框，不會動），id 旁邊多一個「Failed」或「Gave up after N tries」的小標，滑上去說是哪條規則送來的、點開看原因。
  - 人把卡移走或下一次 Run 開跑就不標了，不用另外按「看過了」。
  - `needs_input` 不標：它本來就會被送去專門等人回答的站，站名已經說明。`abandoned` 不標：lease 過期是 engine 自己會收回重跑的事。
  - 實作時定的：`listBoard` 多回一個 `failed`，用 store 現有的 `latestRunsEndedIn` 讀兩次，不加新的 port 方法。`max_attempts` 那筆 Run 本身就是多出來的一次（D38），所以「試了幾次」是它的 attempt 減一。失敗原因只寫在 system comment 裡，Run 沒存，所以小標只說是哪條規則，原因要點開看。
- 理由：外框讓人掃過看板就看得到，小標說清楚是哪一種；只有外框分不出失敗跟放棄，只有小標又容易漏看。
- 實測：`pnpm test` 423 條、`pnpm check` 沒有錯誤。engine 測試確認失敗的兩張卡都被標、人移走一張後只剩另一張；重試到上限的卡標「試了 2 次」、人拉回去重跑成功後不標。E2E 多一條：`[fake:failed]` 的卡被送到 Blocked 後有紅框與 Failed，人移回 Refining 後兩者都消失。
- 重新檢視：要在小標上直接看到原因時，Run 要多存一欄 reason。

## D94 流程設定的歷史照概念列出改了什麼，回到一版是倒回表單再存

- 背景：W4b（2026-11-22）。D91 的 store 已經把每一版連同存的人與時間留著，這次補上看歷史與回到任一版。
- 決定：
  - 「改了什麼」照概念講，不給 JSON 對照（作者選的）：加了或拿掉哪一站、哪一站的顯示名、tracker status、按鈕、等不等人換了，站的順序，新 item 從哪站開始、失敗送去哪，task status 對照，規則加了拿掉、盯的站、工作中移去哪、agent、mode、次數、session、每個結果送去哪，hold label。prompt 這種長字串只寫「改了」，點開才左右對照前後兩段，空的顯示成 mode 的預設。
  - 每一版跟它的前一版比，第一版跟它取代的預設流程比。比對在 server（`flow-changes.ts`），對的是存進去的原樣，省略的欄位照表單的說法顯示成預設；站與規則用 id 認，改 id 會顯示成拿掉一個、加一個，因為 tracker 上那就是另一個 status。
  - 「回到這版」只把那版倒回表單，表單上方說是哪一版，按 Save 才存成新的一版，舊的不刪不改。寫入只有 W4a 那一條：版本號比對（409）、tracker 沒有的 status、被拿掉的 status 上還有人、agent 對不上，全部照常檢查。
  - 實作時定的：StorePort 多一個 `flowHistory()`，每一版、新的在前，testkit 的 store 契約多一條。REST 多 `GET /api/flow/history`，跟 `GET /api/flow` 一樣只給 `admin` 與 `maintainer`，也不進使用者 MCP（D91）。沒有分頁，一次讀回全部。
- 理由：
  - 設定頁選表單是為了不寫程式的人（D91），歷史也用同一種說法，不然看得懂表單的人看不懂歷史。
  - 回到一版另開一條寫入的路，就要把 W4a 的每一項檢查再接一次；倒回表單再存，檢查自然都在，人也能在存之前先看一眼、順手再改。代價是要多按一次 Save。
- 實測：`pnpm test` 433 條、`pnpm check` 沒有錯誤，`pnpm e2e` 36 條全過，sqlite 與 jira 各多一條：改第一條規則的 prompt 存檔、歷史最新一版標 In use 並寫「prompt changed」、點開看得到新 prompt、Restore 前一版後表單上方出現提示且 prompt 回到舊的、存檔後多一版。`flow-changes` 的單元測試逐項驗每一種改法，server 測試驗歷史的順序、第一版對預設、倒回舊版再存是新的一版且列出反向的改變。
- 重新檢視：版本多到一次讀回太慢時加分頁；有人需要「誰改了這一欄」的逐欄追溯時，再看要不要存 patch 而不是整份。

## D95 `doctor` 把檢查交給 plugin、心跳的細節、啟動只擋檔案這邊的錯

- 背景：S10（2026-11-22）。plugins.md 待定 2 問 `doctor` 怎麼把 Jira workflow 與 CLI preflight 這種只有 plugin 知道的事交出去；D66 定了用心跳擋第二個 engine，但沒定多久算新鮮。
- 決定（作者選 A）：
  - `TrackerPort` 與 `RunnerPort` 各加一個選用的 `doctor`，回傳 `{ level: 'error' | 'warning', message }[]`。engine 把規則會走的轉移整理好（邏輯名，`ruleTransitions`）交給 tracker，plugin 自己判斷合不合法；engine 只收集、加上「tracker @tasuki/jira-cloud」「agent claude-main」這種前綴再印。沒實作就是沒東西要查。選用的方法舊 plugin 不用改，`apiVersion` 維持 1。
  - 心跳是 tracker 的選用方法 `readHeartbeat`、`writeHeartbeat`（`undefined` 是清掉）。Jira 存在 project property `tasuki.heartbeat`，sqlite 不實作。engine 每輪一開始就寫，暫停或有沒對上的 status 時也寫，因為它還佔著這個 project。比三輪 poll 新就算還活著（Jira 預設 30 秒一輪，就是 90 秒）。`engineId` 是「主機名:data dir」，同一台機器、同一個 data dir 重開時認得出是自己留下的，`pnpm dev` 改檔重啟不用等。收到 SIGINT、SIGTERM 時清掉自己的心跳，下一個 engine 馬上能起。
  - `doctor` 先做成 server 的子指令，S12 再包成 `tasuki doctor`。每一項都跑完才結束：config 讀不了、store 或流程載不起來時後面沒得查才停，tracker、各 agent、auth 各自失敗不影響別人。
  - 啟動時：另一個 engine、agent preflight 的 error 拒絕啟動。流程對 tracker 的問題（tracker 沒有的 status、workflow 不允許的轉移）只印出來照樣啟動，跟 D91 一樣，因為流程要在設定頁改，拒絕啟動就改不了了。
  - Jira 的轉移檢查：`POST /rest/api/3/workflows` 依 issue type 讀 workflow，`GLOBAL` 轉移從哪都能進、`DIRECTED` 只從 `links` 列的 status 進。transition 上的 condition（限定誰能按）不看。看板：`/rest/agile/1.0/board?projectKeyOrId=` 列出的每個看板，tasuki 用到、project 裡有、但沒有任何一欄放的 status 警告。欄位順序不檢查，也不代為去改（plan.md 待釐清 14 剩下的部分）。
  - claude 的 preflight：`--version` 跑得起來；`allowedTools` 空的警告；`requires` 有東西才照 Run 的載入方式（`--plugin-dir`、`--mcp-config`、隔離旗標）起一次 `claude -p`，一行一行找 `type: system, subtype: init`（前面還會有 `ui_status` 之類的），MCP server 要是 `connected`（也看過 `failed`、`needs-auth`），skill 照 `init.skills` 的名字比（plugin 的是 `sdd:apply` 這種），讀到就砍整個 process group，60 秒沒出現算錯。codex 留到 S12。
- 理由：
  - 檢查交給 plugin，Jira 與 CLI 的細節才不會漏進 core（D44）。只讓 plugin 交原始資料、engine 自己比，第 8 條還做得到，「有沒有裝 skill」沒辦法變成通用的資料。在工廠裡丟錯只有過或不過，也沒辦法一次列完。
  - `engineId` 用隨機值的話，當掉或被 `vp pack --watch` 直接重啟後，要等三輪才起得來；同一台機器、同一個 data dir 也不可能是別人的 engine。
- 實測：`pnpm test` 450 條、`pnpm check` 沒有錯誤。KAN 上：`doctor` 對作者的 config 是 0 error 0 warning；起一個 engine 後，用另一個 data dir 起第二個被拒（「seen 2s ago」），`doctor` 也報同一條 error；SIGTERM 第一個後 property 回 404，第二個的 `doctor` 不再報。真的 claude 2.1.323：繼承設定時 `playwright` connected、`sdd:apply` 有，沒有的 MCP 與 skill 各報一條；隔離時 `sdd:apply` 讀不到；跑完沒有殘留的 process。testkit 的 tracker 契約多一條心跳的寫讀清。
- 沒做：security-and-auth.md 說 `doctor` 與啟動 log 要列出 plugin 的版本，目前只列名字，plugin 沒有宣告版本，要從套件的 `package.json` 讀。
- 重新檢視：設定頁存檔時也想擋 workflow 不允許的轉移時（現在只在 `doctor` 與啟動時印）；Jira 的 transition condition 擋到 engine 時；有人在同一台機器用同一個 data dir 開兩個 engine 時。

## D96 S11：testkit 改用 vitest、core 是第三方的 peer、範例裝在 workspace 外面驗

- 背景：S11（2026-11-22）。要讓第三方照文件寫出 tracker 並通過契約測試。plugins.md 待定 1、3、4 還沒定，testkit 從 `vite-plus/test` import，第三方不裝 Vite+ 就跑不動。
- 決定（作者同意）：
  - 這片做到「發得出去」：`core` 與 `testkit` 拿掉 `private`、加上 `files: ["dist"]`，用 `pnpm pack` 的 tarball 驗。真的 `npm publish` 在 S14（D97），因為現在發出去，別人也裝不到 engine。版本留在 `0.0.0`，發版時再定。
  - testkit 改成從 `vitest` import，peer 是 `vitest`，workspace 裡用 devDependency 的 `vitest` 5.1.0。`vite-plus/test` 本身就是 `export * from 'vitest'`，workspace 解析到同一份 vitest，內建 plugin 的契約照常跑。
  - testkit 依賴確切版本的 `core`（`workspace:*` pack 成 `0.0.0`），兩個一起升，契約永遠對著它那一版的 port。這回答了 D62 「發布時要不要改回範圍」的問題：先不改。
  - 第三方把 `@tasuki/core` 寫成 `peerDependencies`。core 的 use case 與 server 用 `instanceof` 認 `StatusConflict`、`NotFound` 這些錯誤，plugin 自己帶一份 core 的話 class 對不上。
  - plugins.md 待定 1：options 由 plugin 在工廠裡自己驗，丟錯走載入失敗；JSON Schema 跟 config 的一起決定（待釐清 13）。待定 3：`apiVersion` 維持完全相等，上線前不顧兼容，用不到範圍。待定 4：`tasuki-plugin-<名字>` 或 `@<scope>/tasuki-plugin-<名字>`，`@tasuki/` 留給內建的。
  - 範例放 `examples/tracker-memory/`，不在 `pnpm-workspace.yaml` 的 `packages/*` 裡，也不用 `workspace:*`，工具鏈用一般的 `tsc` 與 `vitest`，相對 import 寫 `.js`（`NodeNext`），跟 repo 自己的 D43 不同，因為它要照第三方的樣子 build 出 Node 直接跑得動的檔案。root 的 lint 跳過 `examples/`（在 repo 裡沒有裝它的依賴），由 `pnpm verify:plugin-example` 檢查。
  - 契約只做 tracker 跟原本就有的 store。runner 的契約等 S12 有第二個真的 runner（codex）再長，auth 還沒排。
- 理由：驗收是「照文件寫出第三方 tracker」，只有在 workspace 外面、從發佈出去的形狀安裝，才擋得住 `files` 漏掉、依賴寫錯這種問題，`workspace:*` 都會把它們蓋掉。
- 實測：`pnpm verify:plugin-example` 在暫存資料夾用 npm 從 tarball 裝好，型別檢查過、契約 31 條（30 條契約加 1 條 options）全過、`tsc` build 後 import 得到 `definePlugin` 的結果。另外手動在同一個資料夾裝 sqlite、fake-runner，config 的 tracker 指到 `tasuki-plugin-memory`：`doctor` 0 error 0 warning，`start` 後 `POST /api/items` 建出 `MEM-1`，`GET /api/board` 在 `refining` 欄看得到。`pnpm test` 450 條、`pnpm check` 沒有錯誤。
- 發現、留給 S12：內建的 `sqlite`、`fake-runner` 這些套件沒寫 `files`，`dist` 又在 `.gitignore` 裡，`pnpm pack` 出來沒有 `dist`；上面的手動驗證是把 `dist` 複製進去的。S12 打包 CLI 時一起補。
- 重新檢視：`core` 到 1.0、要對外承諾相容時（`apiVersion` 改範圍、peer 改範圍）；有第三方用不是 vitest 的測試框架時；verify 要進 CI 時（現在要連網路裝 `vitest` 與 `typescript`）。

## D97 對外發佈集中到最後一片 S14，之前作者自己整體測一輪

- 背景：2026-11-22，S11 做完後。原本 npm 發佈散在 S11（testkit）與 S12（CLI、container image）。
- 決定（作者提的）：
  - 新增 S14「對外發佈」，排在 S13 之後，凡是會讓外面的人拿到東西的事都放這裡：license（待釐清 9）、npm 套件名稱查撞名（D23）、版本號與依賴要不要改回範圍（D62、D96）、`npm publish` core、testkit、內建 plugin 與 CLI、container image 推到 registry、給使用者看的 README，含訂閱帳號與 API key 的服務條款（plan.md 待驗證）。
  - S12 改成做到本機為止：CLI 從 `npm pack` 的 tarball 裝得起來，container image 在本機 build 得起來。內建套件補 `files`（D96 發現的）留在 S12，因為本機從 tarball 裝 CLI 就需要它。
  - S13 做完、進 S14 之前，作者自己把整個產品測一輪並調整。調整照 S7e 的方式插成切片，全部定了才進 S14。
- 理由：發佈出去就收不回來，版本與名稱都會被別人裝走。集中在作者測過、調過之後，才不會發了一版又馬上推翻。本機裝得起來的部分還是在功能切片裡做，作者測的時候才是用真的安裝方式在測。
- 重新檢視：有人要在 S14 之前先用某個套件時（例如有第三方要寫 plugin）。

## D98 S12a：`tasuki` CLI、內建 plugin 跟著 CLI 裝、engine serve 看板

- 背景：S12（2026-11-22）。原本一片包了 CLI 打包、container image、codex runner，`init` 怎麼做文件也沒定。全域裝的 CLI 有個載入問題：plugin 只從 config 所在的資料夾解析（plugins.md），使用者隨便開的 instance 資料夾裡沒有 `node_modules`，連 `@tasuki/sqlite` 都找不到。
- 決定（作者同意）：
  - S12 拆成四片：S12a CLI（`start`、`doctor`、`pause`、`resume`）、engine serve 看板、從 tarball 裝；S12b 互動式 `init`；S12c container image 加 claude 的 `api-key` 與 `oauth-token`；S12d codex runner，做到契約測試會過（作者沒有 Codex 帳號，真的跑掛在 plan.md 待驗證）。
  - 新增 `packages/cli`（`@tasuki/cli`，bin 是 `tasuki`），只做參數解析。`server` 從可執行檔改成 library，匯出 `startEngine`、`runDoctor`、`pauseCommand`、`resumeCommand`。
  - 內建 plugin 全部列在 CLI 的 `dependencies`，跟著 CLI 一起裝。loader 先從 config 的資料夾解析，找不到再從 engine 自己安裝的位置解析。config 旁邊裝了同名套件的話，用 config 旁邊那份。內建的沒有因此多拿到什麼，第三方放在 config 旁邊一樣找得到，D44 不變。
  - engine 在 `/` serve 建好的看板（`createApp` 的 `webDir`）。CLI build 時把 `web/dist` 複製到自己的 `web/`，跟著 tarball 走；沒有 client 路由，不做 SPA fallback。開發時照舊由 Vite 在 5173 serve。
  - `tasuki pause [--kill]` 與 `resume` 直接開 store 呼叫 `pauseEngine`、`resumeEngine`（D73 的同一組 use case），不打 REST。跑著的 engine 每一輪從 store 讀暫停旗標，`enforce` 每秒讀 cancel 要求，所以不需要連到 engine，有 auth 也不用登入。sqlite 開 DB 加 5 秒的 busy timeout，兩個 process 同時寫時等鎖，不直接丟 `SQLITE_BUSY`。
- 理由：每個 instance 資料夾各裝一次內建 plugin，前台多一步、每個資料夾多一包 `node_modules`，plugin 帶的 core 也可能跟 CLI 的不同版。退回 engine 安裝位置只多一層 `createRequire`，npm 裝出來的樹裡 `@tasuki/server` 跟內建 plugin 是兄弟，workspace 裡則走到根目錄的 devDependencies，兩邊都不用多傳參數。
- 實測：`pnpm verify:cli-install` 用 `pnpm pack` 打出 core、server、六個內建 plugin 與 cli 的 tarball，在暫存資料夾用 npm 裝起來（各套件互相要 `0.0.0`，registry 上沒有，用 `overrides` 指到 tarball），另一個只放 config（sqlite 加 fake-runner）的 instance 資料夾跑裝好的 `tasuki`：`doctor` 0 errors 0 warnings；`start` 之後 `/` 是看板、它的 script 拿得到；`pause --kill` 後 `GET /api/board` 回 `paused: true`，`resume` 後回 false。`pnpm test` 453 條、`pnpm check` 沒有錯誤、E2E 的 sqlite、auth、auth-http 共 19 條過（jira 沒跑，會清空 KAN）。D96 說留給 S12 的 `files` 也一起補了，這次的 tarball 有 `dist`。
- 沒驗的：真的 `npm i -g`。registry 上沒有 `@tasuki/*`，全域安裝不吃 `overrides`，各套件的依賴解析不到，要等 S14 發佈後才驗得了。上面裝進資料夾的樹跟全域的差別只在外面多一層 `@tasuki/cli/node_modules`，從 `server` 往上解析一樣走得到。
- 重新檢視：內建 plugin 要獨立升版、不想跟著 CLI 一起裝時。

## D99 S12b：互動式 `tasuki init`

- 背景：S12b（2026-11-22）。D50 說 Jira 的 id 由 `init` 查好寫進 config、附上名稱；config-and-rules.md 說 `init` 要帶一份預設的 `allowedTools`。其他行為文件沒寫。
- 決定（作者同意）：
  - 依序問 tracker（sqlite 或 Jira Cloud）、agents（claude、fake，可多選，至少一個）、要不要登入（不用或 `auth-builtin`）。`auth-http` 要填外部 API，不放進 init，自己改 config。
  - 選 Jira 時問網址、email、API token（不顯示），打 `GET /rest/api/3/myself` 確認登得進去，不行就整組重問；再問 project key，`GET /rest/api/3/project/{key}` 不是 200 就重問。item 的 issue type 從 `subtask: false` 且 `hierarchyLevel` 是 0 的裡面挑（epic 在 1，排除），task 從 `subtask: true` 的裡面挑。link type 有叫 `Blocks` 的就直接用，沒有才列出來讓人挑。
  - 寫出的 config 是 JSONC，id 旁邊用註解附上 Jira 上的名稱。email 與 token 只寫進旁邊的 `.env`（權限 600，同名的行會被換掉），config 裡寫 `${JIRA_EMAIL}`、`${JIRA_API_TOKEN}`（D49）。claude 的 `allowedTools` 帶範例檔那份。
  - config 已經存在就拒絕，不覆蓋。`--config <路徑>` 指定寫到哪裡。
  - Jira status 的對照不在 init 做，照舊在設定頁挑（W4a），因為它存在 store 裡、不在檔案裡。codex 等 S12d 再加。不做非互動的旗標版本，現在沒有腳本要呼叫它。
  - 問答用 `@clack/prompts`（1.9.0，create-vite 用的同一套）：方向鍵選、空白鍵多選、token 以遮罩顯示、查 Jira 時有 spinner，Ctrl+C 任何一題都不寫檔就結束。先用 `node:readline` 手寫過一版，只有編號輸入，作者覺得太簡陋，換掉；方向鍵選單不是幾行程式寫得完的，所以加這個依賴。只在 `cli`，engine 不依賴它。
  - `doctor` 的輸出上色（error 紅、warning 黃、總結 0 個 error 是綠），用 Node 內建的 `util.styleText`，不是 TTY 或設了 `NO_COLOR` 時照舊是純文字，格式不變。
  - 找不到 config 時的錯誤訊息提示跑 `tasuki init`（config-and-rules.md 路徑一節）。
- 實測：先用 readline 版，把答案 pipe 進去打 KAN（新的暫存資料夾，環境裡拿掉 `JIRA_*`）：查出 item `10009`（故事）、task `10007`（Subtask）、link `10000`（Blocks），`.env` 權限 `-rw-------`。接著同一個資料夾 `tasuki doctor` 0 errors，14 個 warning 都是 status 還沒在設定頁對照。換成 clack 後在 100 欄的 pty 裡用方向鍵與空白鍵走完 sqlite 加 claude 加 auth-builtin，寫出的 config 正確。單元測試 mock 掉 clack，4 條：sqlite 的 config 讓 `runDoctor` 回 0；Jira 錯的 token 與錯的 project 都會重問，寫出的 id、名稱註解、`.env` 內容與權限都對；取消時不寫檔；已經有 config 時不動它。
- 重新檢視：第三方 tracker 也想在 init 問自己的問題時（要給 plugin 一個 init 的 hook）；有腳本要不互動地產生 config 時。

## D100 S12c：container image、claude 的 `api-key` 與 `oauth-token`

- 背景：S12c（2026-11-22）。architecture.md 說雲端是 container image、agent 用 API key，可是 claude-cli 只收 `inherit-login`，container 裡沒有登入可以沿用。D35 的待驗證是兩種認證各吃哪個環境變數。
- 決定（作者同意）：
  - claude-cli 的 `auth` 收 `inherit-login`、`api-key`、`oauth-token`。後兩種要求 `options.env` 裡有非空的 `ANTHROPIC_API_KEY` 或 `CLAUDE_CODE_OAUTH_TOKEN`（對過 code.claude.com/docs/en/authentication）。`-p` 底下 API key 的優先序在 OAuth token 前面，所以 `oauth-token` 的 `env` 裡帶了 `ANTHROPIC_API_KEY` 或 `ANTHROPIC_AUTH_TOKEN` 就拒絕，不讓它默默改用 API 計費。變數照舊只從 `options.env` 進 agent（D35），engine 自己的環境不會漏過去。
  - 根目錄的 `Dockerfile` 分兩段：build 段裝 workspace、`pnpm build`，再用 `scripts/pack-cli.ts` 從 tarball 把 CLI 裝到 `/opt/tasuki`，跟 npm 使用者拿到的是同一包。執行段是 `node:24.22.0-bookworm-slim`，裝 git、ssh client，以及全域的 `@anthropic-ai/claude-code@2.1.323`（D76 驗過的版本）與 `@openai/codex@0.169.0`，用 `node` 使用者跑，config 掛在 `/instance`，狀態在 `/data` volume。`verify-cli-install.ts` 也改成呼叫 `pack-cli.ts`，打包只有一份。
  - `docker/compose.yaml` 與 `docker/tasuki.config.jsonc` 是範例：綁 `0.0.0.0` 加 `allowInsecure`，host 端只開在 `127.0.0.1`（security-and-auth.md 的 Docker 一條、D90）。agent 預設 `api-key`，照 security-and-auth.md「雲端部署的預設」與「`claude setup-token` 這類繞法不寫進官方文件」。`oauth-token` 照樣支援，選哪種是使用者的事。
- 實測（OrbStack，arm64）：image build 成功，執行段 787MB 是兩個 CLI（claude 346MB、codex 403MB）加 npm 快取清掉之後的大小，tasuki 本身 33MB。fake runner 的 config 起來後 `/api/health` 與看板正常，container 裡 `tasuki doctor` 0 errors、`claude --version` 是 2.1.323、`codex --version` 是 0.169.0。接著作者用 `claude setup-token` 產的 token，config 寫 `oauth-token`：存一條 split 規則、把一張 item 移到 `ready-to-split`，claude 在 container 裡約 10 秒拆出兩張 task，Run `finished`、`succeeded`，item 到 `split-review`；Run log 的 `apiKeySource` 是 `none`，container 裡沒有別的登入，用的就是那個 token。`api-key` 沒有實際打過（作者沒有 Console 的 key），行為只靠單元測試與文件。
- 過程中的事故：驗證完找殘留字串時，`grep` 沒排除 `docker/.env`，token 被印進了對話紀錄。作者已撤銷，`docker/.env` 清空。之後掃字串要先排除放 secret 的檔案。
- 重新檢視：image 要推到 registry（S14）；兩個 CLI 要升版時（版本 pin 在 Dockerfile）；有人要跑 arm64 以外的平台時，要確認多平台 build。

## D101 S12d：codex runner、testkit 的 runner 契約

- 背景：S12d（2026-11-22）。D96 說 runner 的契約等第二個真的 runner 再長。作者沒有 Codex 帳號，只能做到契約測試會過（D98）。
- 決定（作者同意）：
  - `@tasuki/codex-cli` 跑 `codex exec --json --skip-git-repo-check --cd <workspace> --sandbox <sandbox>`，prompt 從 stdin 給（最後的參數是 `-`），`-c approval_policy="never"`，tasuki 的 MCP 用 `-c mcp_servers.tasuki.url=…` 與 `mcp_servers.tasuki.bearer_token_env_var="TASUKI_MCP_TOKEN"`，run token 放在那個環境變數，不出現在命令列。選項放在 `resume <id>` 前面，跟官方 TypeScript SDK（`@openai/codex-sdk` 0.169.0）的排法一樣。
  - codex 不能事先指定 session id，runner 讀 `--json` 的第一個事件 `thread.started` 的 `thread_id` 再呼叫 `onSession`。RunnerPort 本來就是事後回報（`onSession`），core 不用改。resume 時 stderr 出現 `no rollout found for thread id`（exit 1）就開新的，跟 claude 一樣。
  - options：`auth`（`inherit-login` 或 `api-key`，後者要 `env.CODEX_API_KEY`；codex 沒有 OAuth token 那種變數，訂閱就是 `CODEX_HOME` 的 `auth.json`）、`model`、`sandbox`（預設 `workspace-write`）、`env`、`inheritSettings`（預設 false，加 `--ignore-user-config --ignore-rules`，登入照樣讀 `CODEX_HOME`）。傳給 CLI 的環境變數是 claude 那份加上 `CODEX_HOME`。
  - 給 codex `allowedTools` 直接拒絕載入，叫人改用 `sandbox`。另一種是把常見的 tool 名稱翻成 sandbox 等級，但那個對應是編出來的；默默忽略又會讓人以為擋住了。`requires` 也拒絕，因為還不知道怎麼偵測 codex 的 MCP server 與 skill；doctor 只檢查 `--version`。
  - testkit 加 `describeRunnerContract`：成功時 exit 是 0、log 有內容、`onActivity` 與 `onSession` 有被呼叫；resume 的 session 不在時開新的並回報新的 id；`terminate` 之後 `exit` 會結束；CLI 不存在時 exit 沒有 code。每個 runner 提供一支假 CLI 演 `succeed`、`hang`、`no-session`，傳給 CLI 的參數仍由各自的測試驗。claude-cli 與 codex-cli 都跑這份。testkit 的 tsconfig 加上 node 的型別，對外的 `.d.ts` 沒有用到任何 `node:` 型別。
  - CLI 的依賴、`pack-cli.ts`、init 的 agent 選單都加上 codex，init 寫 `"sandbox": "workspace-write"`。
- 實測（codex-cli 0.169.0，沒登入，暫時的 `CODEX_HOME`）：用 build 好的 runner 帶真的參數跑真的 codex，沒有任何參數錯誤，第一行是 `thread.started`，session 有回報；log 有 `rmcp` 連不上的錯誤，表示注入的 http MCP 被讀進去了（故意指到連不到的 port）。resume 一個不存在的 id，codex 印 `no rollout found`，runner 開新的並回報新的 thread id。`codex mcp list --json` 讀 `-c` 注入的 server 是 `streamable_http`、`auth_status: bearer_token`。單元測試 10 條（含契約 4 條、process tree 的 terminate），claude-cli 加跑契約後 16 條。從 tarball 裝好的 `tasuki` 對只有 codex agent 的 config 跑 `doctor` 0 errors。`pnpm test` 471 條、`pnpm check` 沒有錯誤、`verify:plugin-example` 31 條過。
- 沒驗的：真的叫模型（沒帳號），所以 MCP tool 在 `approval_policy="never"` 下會不會被擋、`workspace-write` 沒網路時能不能 `git push`、`CODEX_API_KEY` 實際能不能登入，都留在 plan.md 待驗證。
- 重新檢視：有 Codex 帳號時；codex 出了逐個 tool 的權限設定時。

## D102 S13 設計：`dispatch` mode，engine 照依賴圖一張 task 一個 Run

- 背景：S13 開工前（2026-11-22）。D5 先做 M1、D9 寫明 M1 停不了單張 task、D36 把 task 層規則的形狀留到這時候。作者提出三種：一個 item 一個 agent 由它派 subagent、一個 task 一個 agent 由 engine 派、寫進 config 讓使用者選。
- 決定（作者同意）：
  - 兩種並存，規則的 `mode` 選：`execute` 照舊是一個 orchestrator（M1），新的 `dispatch` 由 engine 照 task 圖一張 task 起一個 Run（M2）。第三種就是這個二選一，不另外發明 config 語法。不用 D36 預留的 `kind: "task"` 規則：那種還要多一個「item 在哪站才算數」的條件，item 的出口也會散到兩條規則上。
  - 認領：可跑的 task 是 `to-do` 或沒人負責的 `in-progress`，blockedBy 全部 `done`，照建立順序各起一個 Run，受 `maxConcurrentRuns` 限制，認領時 engine 把 task 移到 `in-progress`。item 底下還有存活的 task Run 時不認領 item 本身（不變量 1 改成以 target 計）。
  - task Run 結束：`succeeded` 到 `done`，不走 `in-review`；`failed`、沒有 verdict、`abandoned` 回 `to-do`；`needs_input` 到 `manual`。attempt 以（task, rule）計，`failed` 也累計，到了 `maxAttempts` 轉 `manual`。task 出事都變成 `manual`，item 自然由 `blocked_manual` 進 `blocked`，不另開出口。
  - item 的出口由 engine 判斷，沒有 agent：task 全 done 走 `succeeded`，沒有可跑的又剩 manual 走 `blocked_manual`。照 D38 `max_attempts` 的做法記一筆不起 process 的 Run，自動接回與卡片標示照舊讀最近一次 Run。
  - worker 的 tool：`get_item`（讀所屬 item）、`list_tasks`、`list_comments`、`add_comment`（`target` 省略時是自己那張 task）、`report_result`。沒有 `set_task_status`，status 由 engine 照 verdict 移；verdict 固定是 `succeeded`、`needs_input`、`failed`。
  - 停單張：task 詳情的 Stop 是 hard cancel 那張的 Run，task 轉 `manual`（人的操作，不違反不變量 6），不貼 `hold`。人把 task 移走是 soft，跟移走 item 一致。討論時講過 Jira 上移走 task 算 hard，寫文件時改成 soft，跟 D9 的 item 一樣。
  - git 接力照 D10 留在 prompt：每張 task 做完自己 merge 回 `feature/<KEY>` 再 push，平行的各開 worktree，push 撞到就拉回來解，解不掉回報 `needs_input`。要整合的由 splitter 多開一張整合 task，engine 不知道它特別。
- 理由：要 hard 停單張，process 就得在 engine 手上。MCP 是 agent 呼叫 engine，engine 插不進正在想事情的 orchestrator；Claude Code 的 Channels 能讓 MCP server 推事件進 session，但它是 stdio、research preview，就算推到了，停不停 subagent 還是 LLM 決定，仍是 soft。`execute` 留著給想讓 agent 自己指揮的人，不用為了 M2 拿掉。
- 代價：engine 多一段排程與 task 層的 attempt；task 之間的接力全靠 git，agent 沒照 prompt merge 回去，下一張就看不到前一張的東西。
- 實作（S13，2026-11-22）：
  - Run 多一個 `item`：item 自己的 Run 是 target 本身，dispatch 的是 task 所屬的 item。看板的 Running、hold、item 的 Stop、改與刪 task 的檢查、不變量 1 都看它，不用每輪去 tracker 查 task 的 parent。store 的 migration 把舊的 Run 補成 `item = target`，testkit 的 store 契約多一條。
  - core 的 `dispatch.ts` 放四件事：認領 task（`claimTasks`，由 `claimItems` 呼叫，跟其他規則共用 `maxConcurrentRuns`）、判斷 item 出口（`settleDispatched`，每輪在復原與接回之後、暫停檢查之前跑，因為它不起 agent）、task Run 結束（`finishTaskRun`）、lease 過期（`recoverTaskRun`）。
  - 停單張走同一個 `stopRun`：ref 是 task 就只停它的 Run 並轉 `manual`，是 item 就照舊貼 hold、停掉它所有的 Run。REST 多一條 `POST /api/tasks/:ref/stop`，使用者 MCP 的 `stop_run` 收 task ref。task 詳情（REST 與 `get_task`）多了 `runs`，item 詳情的 `runs` 把 task 上存活的放前面，看板的 task 詳情有 Stop。
  - prompt 多一個 `{{task.ref}}`。`dispatch` 的預設 prompt 叫 agent 開自己的 worktree、做完 merge 回 `feature/<item>` 再 push。
  - 讀檔時 `dispatch` 規則不收 `claim` 與自己宣告的結果，設定頁選 Dispatch 時也不顯示這兩樣。doctor 第 8 條多列 dispatch 會走的 task 轉移。
  - fake runner 在 dispatch 時從 task 自己的標題讀 `[fake:...]`，只回報，不碰 task。
- 實測：`pnpm test` 490 條、`pnpm check` 沒有錯誤。engine 的整合測試多 8 條：沒有互相等待的 task 一起跑、其餘照順序、全 done 送 `in-review`；`needs_input` 轉 manual、item 進 `blocked`、人做完後接回；失敗兩次後第三輪轉 manual；Stop 只停那一張；人移走 task 或 item 時 soft cancel，而且 split 規則在 task 的 agent 還在時不認領；hold 停掉所有 task 的 agent；lease 過期送回 `to-do` 再跑 attempt 2；worker 只有讀與留言的 tool。E2E 的 sqlite 18 條過，多的一條是 `parallel` 站：在 split-review 把一張 task 改名成 `[fake:hang]`、送到 `parallel`、在 task 詳情按 Stop、標成 done，另一張由自己的 agent 做完，item 到 `In Review` 顯示 2/2。Jira 沒有跑：KAN 沒有 `parallel` 這個 status，E2E 的 Jira 流程把 dispatch 規則拿掉；Jira 的 task workflow 允不允許 `in-progress → done` 這類轉移，要用 doctor 對 KAN 查。
- 重新檢視：Channels 能在 headless 用、要給 `execute` 加快 soft stop 時（plan.md 待驗證）；要讓 AI 審單張 task 時（目前 dispatch 不走 `in-review`）；要限制單張 item 的平行數時。

## D103 agent 讀得到附件

- 背景：S13 之後（2026-11-22）。facade 沒有讀附件的 tool，body 裡的圖片 agent 只看到 `attachment:<id>` 這串字，沒連進 body 的附件連存在都不知道。作者指出附件常常不放在 body，task 也會依賴 item 上的附件，agent 要拿到所有資訊才判斷得對。
- 決定（需求是作者提的，tool 的形狀是這次定的，作者還沒看過）：
  - facade 加 `list_attachments`（不帶參數，列出 item 與它每張 task 上的所有附件）與 `read_attachment`（`target`、`id`），每種 mode 都有。範圍跟 `list_comments` 一樣是 Run 那張 item 與它的 task，dispatch 的 worker 也讀得到 item 上的。
  - 不把附件清單塞進 `get_item`、`list_tasks`：Jira 每張 issue 讀附件要一次 API，agent 常常列 task，每次多打 N 次。改成獨立一個 tool，engine 的契約寫明一開始要讀附件。
  - 走 MCP，不把檔案放進 workspace：agent 的 `allowedTools` 預設全擋（D35），放進資料夾也打不開；MCP 是每個 runner 都接得到的那一條。
  - `read_attachment` 依 mimeType 回：png、jpeg、gif、webp 回 image content，`text/*` 與 json、xml、yaml 回 text，其他回 base64 的 resource blob。附件上限 10MB，清單先列、要用才讀，大圖不會一開始就塞進對話。
- 實測：engine 的整合測試一條：沒連進 body 的附件也列得出來，item 上的圖片回 image、task 上的文字檔回內容，別張 item 的附件讀不到。`pnpm test` 491 條、`pnpm check` 沒有錯誤。
- 沒驗的：真的 claude 與 codex 收到 image content 與 resource blob 會怎麼處理（plan.md 待驗證）。
- 重新檢視：agent 讀大附件的 token 成本成為問題時（例如圖片先縮圖）；要讓 agent 寫附件時。


## D104 幾站可以共用同一個 tracker status，item 在哪站記在 store

- 背景：2026-11-23 作者提出。Jira 那邊只有 To Do、In Progress、Done 這種粗的 status，作者想在 tasuki 這邊自己分站，例如 `refining` 與 `split-done` 都對到 To Do、`in-progress` 與 `reviewing` 都對到 In Progress，Jira 不用跟著多開 status。原本每站的 `key` 不能重複，tracker 讀回來的 status 只能反推出一站。
- 決定：
  - item 的站可以共用 `key`。共用同一個 key 的幾站算一組，`workflow.statuses` 裡排最前面的那站是這組的第一站。task status 不變，還是一個對一個。
  - 不另開模式或開關：沒有站共用 key 時行為跟原本一樣，有共用時才用到下面的紀錄。`tasuki init` 也不用多問，對照本來就在設定頁設（D99）。
  - item 在一組裡的哪一站，記在 store（每張 item 一筆：ref 與站），不寫進 tracker。item 在第一站時不記，沒有紀錄就是第一站，所以人在 Jira 上建的、`dataDir` 清掉之後的 item 都落在第一站。作者接受 `dataDir` 掉了這些位置就沒了。
  - core 包一層 TrackerPort 處理，tracker plugin 不用改，因為它們本來就是拿流程設定的對照把站翻成 tracker 的 status：
    - 讀：tracker 回的是這組的第一站，store 有紀錄而且紀錄的站跟它同一組，就換成紀錄的站。`list` 照要的站去問 tracker，換完再濾掉不是要的站。
    - 紀錄的站跟 tracker 現在的 status 不同組（人在 Jira 上把卡拖走了），或那站已經不在流程裡，就刪掉紀錄、用 tracker 的。讀的時候就刪，不然卡片之後被拖回原本的 status，舊的站會跑回來。不留 comment：卡是人自己拖的，而且這是讀的路徑，不該對 tracker 寫東西。
    - 同一組裡移動（`refining` 到 `split-done`）只改 store，不打 tracker。compare-and-set 照舊：item 現在不在 `expectedFrom` 就丟 `StatusConflict`。store 的寫入本身也是 compare-and-set，兩個同時移的只有一個成功。
    - 跨組移動先確認 item 真的在 `expectedFrom`，再叫 tracker 轉，成功後照目標站寫或刪紀錄。tracker 自己的 compare-and-set 只看得到組，分不出同一組的兩站。
    - 建 item 時目標站不是第一站就寫紀錄，刪 item 時刪紀錄。
    - `doctor` 第 8 條不問同一組裡的移動，那不是 tracker 的轉移。
  - 同一組裡移動不改 `version`。version 是 tracker 的，用來擋同時編輯 title 與 body（`EditConflict`），status 的衝突本來就靠 `expectedFrom`。
  - 存流程設定時多擋一種：一組的第一站換了（前面插了一站、重排、第一站被移出這組），原本第一站上有 item 時不准存，因為沒有紀錄的 item 會整批跑到新的第一站。跟「改了 key 或拿掉的站上不能有 item」同一條檢查。
- 理由：
  - 紀錄放 store 不放 Jira 的 issue property：讀看板不用跟 Jira 多要 property，同一組裡移動不打 Jira，store 有 transaction，compare-and-set 做得到；property 是後寫的蓋掉先寫的。一個 project 只接一個 engine（D66），不會有兩台機器的紀錄對不上。代價是紀錄跟著 `dataDir`，作者接受。
  - 包在 core 不放進 tracker plugin：兩個內建的 tracker 與第三方的都直接能用，契約不變。
- 代價：
  - store 多一張表與三個方法，每個 store plugin 都要實作，testkit 的 store 契約多幾條。
  - 跨組移動與同一組裡移動在 Jira 上各多一次 `get`，因為要先確認 item 在哪站。
  - Jira 上看不到細的站，同一組的卡在 Jira 看板上是同一欄。這是作者要的。
- 重新檢視：要讓不經過 tasuki 的人或工具看得到細的站時（改放 issue property）；要讓 task status 也共用 key 時；`dataDir` 掉了位置也不能掉時。
