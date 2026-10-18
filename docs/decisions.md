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

## D5 v1 做 M1，資料模型照 M2 設計
- 決定：task 是一等紀錄（有自己的 status），v1 由每個 item 一個 orchestrator 自己排程。
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
