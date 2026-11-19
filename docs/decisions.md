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
- 狀態：程式碼隨 M1 一起丟掉（D41），這條保留為設計假設，做到 S4 時用真正的規則重新確認。
- 決定：新 Run 的 `attempt` 是上一次 Run（同一張 item、同一條 rule）若為 `abandoned` 就加 1，否則回到 1。要開的 attempt 超過 `maxAttempts` 時，engine 不起 agent，而是建立一筆 outcome 為 `max_attempts` 的 Run，item 走該規則 `on.max_attempts` 的出口，並寫一則 `system` comment。
- 理由：文件只明講 `abandoned` 之後 `attempt + 1`，而 `stop-and-recovery.md` 又說人在 loop 裡的來回不設上限，所以 `succeeded`、`needs_input`、`failed`、`cancelled` 之後都不該累計。把 `max_attempts` 記成一筆 Run，item 被人拉回去之後，上一筆是 `max_attempts` 就從 1 重算，等於「人手動拉回就歸零」，不用觀察人的移動。
- 狀態：暫行做法，待釐清 3 還沒結案。作者確認前先照這個寫。
- 重新檢視：出現 `failed` 要自動重試的需求，或需要 item 層累計成本上限時。

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
