# Glossary

## 工作單

| 名詞 | 意思 |
|---|---|
| item | 一張工作單。Jira 的一般 issue，sqlite 的一列。status 用 item 那一組。 |
| task | item 底下的子單，只有一層。Jira 的 Sub-task。status 用 task 那一組。 |
| work unit | item 與 task 的共同型別，欄位 `kind` 區分。 |
| ref | tracker 內的 opaque key，例如 `PROJ-123`。domain 不解析它的格式。 |
| status | 邏輯名（kebab-case）。流程設定的 `workflow` 把它對到 tracker 的 key（每站的 `key`，task 的 `taskStatuses`）；沒寫 key 就是邏輯名本身，sqlite 這樣存（D91）。 |
| workflow | 流程設定的 `workflow`：item 的 status 清單（順序就是看板的欄）、角色、task status 的對照（D81）。 |
| 流程設定 / 啟動設定 | 流程設定是 status、角色、task status 對照、規則與 prompt、hold label，存在 store、在設定頁上改、下一輪 poll 生效；從沒存過時用預設流程。啟動設定是 config 檔裡其餘的部分（tracker、store、auth、server、agent、poll、limits），由部署的人改，改了要重啟（D91）。 |
| role | 程式需要點名某一站時認的用途，由 `workflow.roles` 指定：`entry`（新 item 從這裡開始）、`failure`（規則失敗的預設去處）。看板打回時要先寫改什麼的那站不是角色，是 rework 規則盯的那站（D86）。 |
| handledBy | 一站誰處理：`engine`（有規則 watch，從規則算）或 `person`（流程設定寫的）。看板分別標雷達與眼睛。 |
| outcomes（站上的） | 人在這站能把 item 送去哪些站，一站一顆按鈕，最後一個是主按鈕。按鈕字是「→ 目標站的顯示名」，不寫在設定裡（D87）。規則上給 agent 的 `outcomes` 是結果名到站的 map（D84）。 |
| logical name / display name | 邏輯名是設定與程式用的 key（`ready-to-split`），顯示名是 UI 用的 Title Case（`Ready to Split`）。 |
| manual task | status 為 `manual` 的 task，等人做。 |
| attachment | item 上的附件。body 用 `![說明](attachment:<id>)` 引用。 |
| embed token | body 或 comment 裡的 `[[embed:<標籤>\|<內容>]]`，代表 tracker 有但 markdown 表達不了的內容（Jira 的 mention、表格），存回去時原樣放回（D61）。 |
| version | work unit 的不透明版本，title、body、status 改了就變。編輯帶著開始時的 version，被別人改過就是 `EditConflict`。 |
| origin | task 是誰建立的，`refine`、`splitter`、`human` 三種。 |
| hold | item 上的 label（名稱可設定）。貼上後 AI 不碰這張 item。 |
| blocked | item 的 status，預設流程裡 `failure` 角色那站，系統發現卡住了。跟 hold 不同，hold 是人叫 AI 別碰。 |
| split-review | item 的 status，預設流程裡拆完 task 之後等人檢查的關卡。 |
| gate | 規則之間需要人放行的點。目前只有 split-review，可在流程設定裡略過。 |

## Engine

| 名詞 | 意思 |
|---|---|
| engine | 單一 process，包含 API、Poller、規則比對、派工、結果處理。 |
| tracker | item、task、dependency、comment 住的地方，plugin 的一個角色。sqlite 或 Jira 二選一，兩邊不同步。 |
| store | engine 自己的狀態（Run、paused 旗標、帳號的 access、session、個人 API token），plugin 的一個角色。預設 sqlite，Jira 模式也有（D88）。 |
| Poller | 定時掃描 tracker 的驅動端，不是核心，只是定時呼叫 use case 的人。 |
| rule | 流程設定裡的一條規則：監看某個 status，命中就跑某個 agent，依 outcome 轉 status。 |
| claim status | rule 認領 item 之後 item 暫停的 status，純粹顯示用。可以沒有。 |
| Run | 一次 agent 執行，記錄在 store。 |
| outcome | Run 的結果：規則 `outcomes` 裡的一個結果名（`succeeded`、`needs_input`、`blocked_manual`、`failed`，或規則自己宣告的，例如 `approve`），或只有 engine 會給的 `max_attempts`、`cancelled`、`abandoned`。 |
| verdict | agent 用 `report_result` 回報的結論，只能是這條規則 `outcomes` 裡的結果名（`max_attempts` 除外）。mode 自己的結果與 `needs_input` engine 驗證過才換算成 outcome，規則自己宣告的照表搬（D84）。 |
| lease | Run 的存活租約，定期續約。同一個 target（item 或 task）同時最多一個存活的 Run，防重複派發和當機復原都靠它。 |
| attempt | 同一張 item 在同一條 rule 上的第幾次 Run。只有前一次 Run 是 `abandoned` 才往上加，其他結果之後都從 1 重新算（見 D38）。 |
| workspace | engine 給每張 item 的工作目錄，Run 的 cwd。 |
| heartbeat | engine 每輪寫在 tracker 上的 `{ engineId, lastSeen }`，第二個 engine 看到它還新鮮就拒絕啟動（D66、D95）。sqlite 沒有。 |
| doctor | 啟動前的檢查：config、plugin 載入、流程對 tracker 的 workflow、agent preflight、另一個 engine。全部列完才結束，有錯就 exit 1（D95）。 |

## Agent

| 名詞 | 意思 |
|---|---|
| splitter | 規則 A 與 C 跑的 agent。檢查 refine 結果、拆 task、把 rework 意見轉成新 task。唯一能建立 task 的角色。 |
| orchestrator | 規則 B 跑的 agent。執行 task：派 subagent、更新 task 狀態、處理 merge。 |
| worker | `dispatch` mode 的規則跑的 agent。engine 一張 task 起一個，它只做那一張，只能讀與留言，task 的 status 由 engine 照它的 verdict 移（D102）。 |
| custom | 不受 mode 限制的規則：agent 拿到全部的 tool，engine 不驗它回報的結果，要做什麼全看 prompt，選它的人自己負責（D92）。 |
| reviewer | `review` mode 的規則跑的 agent。只能讀 item、task、comment 與留言，結論全部由規則的 `outcomes` 宣告，例如 AI code review（D84）。 |
| subagent | orchestrator 自己派的子 agent，engine 看不到。 |
| runner | RunnerPort 的實作，spawn 某個 agent CLI。 |
| fake runner | `@tasuki/fake-runner`，不叫 LLM 的假 agent，照 item 標題裡的 `[fake:<verdict>]` 回報結果（規則有這個結果時），沒有標記時先建兩張 task 再回報 `succeeded`，review 時留一則 note 再回報規則的第一個結果，拿來試 engine 與跑 E2E（D63、D65）。 |
| MCP facade | engine 提供給 agent 的 MCP 入口，背後呼叫 use case。 |
| 使用者 MCP | engine 在 `/mcp` 提供給使用者自己的 AI client（Claude Code、Codex）的 MCP 入口，身分是使用者，能做的事跟看板一樣（D57）。 |
| access | 帳號的權限：`admin`（管帳號、改設定、用系統）、`maintainer`（改設定、用系統）、`member`（用系統）。存在 store，跟帳號由誰管無關（D89）。跟 workflow 的 role 是兩回事。 |
| setup token | store 裡沒有 `admin` 時 engine 印在啟動 log 的一次性 token，用來建立或升級第一個 `admin`（D89）。 |
| 個人 API token | 使用者在看板上產生、給 `/mcp` 用的 Bearer token，存 hash、可撤銷，權限跟著產生它的人（D60）。 |
| run token | 每個 Run 發一個的 token，綁定該 item 與底下的 task，Run 結束就失效。 |
| M1 / M2 | M1 是 task 只是紀錄、由 orchestrator 自己排程，就是 `execute` mode。M2 是 engine 依賴圖排程 task，每個 task 一次 Run，就是 `dispatch` mode。兩種並存，規則選一種（D102）。 |

## 架構

| 名詞 | 意思 |
|---|---|
| port | application 層定義的介面，例如 TrackerPort。 |
| plugin | 提供 tracker、store、runner、auth 其中一個以上角色的 npm 套件，與 engine 同一個 process。內建的與第三方的走同一條載入路徑。 |
| testkit | 契約測試套件。任何 tracker、store、runner、auth 實作都要通過同一組，才算遵守 port。 |
| adapter | port 的實作。 |
| compare-and-set / StatusConflict | status 轉移帶著呼叫端以為的目前 status（`expectedFrom`），對不上就不轉，丟 `StatusConflict` 並附上 item 現在的樣子。人在看板上看到的是舊資料時，靠它不蓋掉別人剛做的移動。 |
| driving adapter | 從外面呼叫 use case 的入口：REST、MCP、Poller。 |
| driven adapter | use case 往外呼叫的實作：tracker、store、runner、auth、clock。 |
| soft stop / hard stop | soft 是不再派新工作、目前這步做完就停。hard 是馬上終止。 |
