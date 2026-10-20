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
- 釘版本：`vite-plus` 釘確切版本（`1.3.0`），`pnpm-workspace.yaml` 的 `overrides` 要寫同一個版本，`vitest` override 要等於 `vp toolchain vitest` 顯示的版本。升級時三處一起改。官方文件提到相依性機器人只升其中一個會造成不相容。
- 寫測試：從 `vite-plus/test` import，不從 `vitest` import。
- 已知現象：`vite` 被 override 成 `@voidzero-dev/vite-plus-core`，pnpm 拿它的版本號 1.3.0 去比對 vitest 要求的 `^6.4 || ^7 || ^8`，報 unmet peer。實際打包的 vite 是 8.3.4，不是執行期不相容。維護者在 `voidzero-dev/vite-plus` 的 #1021 與 #2806 說目前只能用 `peerDependencyRules.allowAny`，根本解法是把 core 的版本號對齊 Vite 的 major，#2806 還開著。
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
