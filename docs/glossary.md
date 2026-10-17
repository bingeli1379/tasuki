# Glossary

## 工作單

| 名詞 | 意思 |
|---|---|
| item | 一張工作單。Jira 的一般 issue，sqlite 的一列。status 用 item 那一組。 |
| task | item 底下的子單，只有一層。Jira 的 Sub-task。status 用 task 那一組。 |
| work unit | item 與 task 的共同型別，欄位 `kind` 區分。 |
| ref | tracker 內的 opaque key，例如 `PROJ-123`。domain 不解析它的格式。 |
| status | 邏輯名（kebab-case）。config 的 status mapping 把它對到 tracker 的實際名稱。 |
| logical name / display name | 邏輯名是 config 與程式用的 key（`ready-to-split`），顯示名是 UI 用的 Title Case（`Ready to Split`）。 |
| manual task | status 為 `manual` 的 task，等人做。 |
| origin | task 是誰建立的，`refine`、`splitter`、`human` 三種。 |
| hold | item 上的 label（名稱可設定）。貼上後 AI 不碰這張 item。 |
| blocked | item 的 status，系統發現卡住了。跟 hold 不同，hold 是人叫 AI 別碰。 |
| split-review | item 的 status，拆完 task 之後等人檢查的關卡。 |
| gate | 規則之間需要人放行的點。目前只有 split-review，可在 config 裡略過。 |

## Engine

| 名詞 | 意思 |
|---|---|
| engine | 單一 process，包含 API、Poller、規則比對、派工、結果處理。 |
| tracker store | item、task、dependency、comment 住的地方。sqlite 或 Jira 二選一，兩邊不同步。 |
| runtime store | engine 自己的狀態（Run、paused 旗標）。永遠是本機 sqlite，Jira 模式也有。 |
| Poller | 定時掃描 tracker 的驅動端，不是核心，只是定時呼叫 use case 的人。 |
| rule | config 裡的一條規則：監看某個 status，命中就跑某個 agent，依 outcome 轉 status。 |
| claim status | rule 認領 item 之後 item 暫停的 status，純粹顯示用。可以沒有。 |
| Run | 一次 agent 執行，記錄在 runtime store。 |
| outcome | Run 的結果，七種：`succeeded`、`needs_input`、`blocked_manual`、`failed`、`max_attempts`、`cancelled`、`abandoned`。 |
| verdict | agent 用 `report_result` 回報的結論，四種：`succeeded`、`needs_input`、`blocked_manual`、`failed`。engine 驗證過才換算成 outcome。 |
| lease | Run 的存活租約，定期續約。同一張 item 同時最多一個存活的 Run，防重複派發和當機復原都靠它。 |
| attempt | 同一張 item 在同一條 rule 上的第幾次 Run。 |
| workspace | engine 給每張 item 的工作目錄，Run 的 cwd。 |

## Agent

| 名詞 | 意思 |
|---|---|
| splitter | 規則 A 與 C 跑的 agent。檢查 refine 結果、拆 task、把 rework 意見轉成新 task。唯一能建立 task 的角色。 |
| orchestrator | 規則 B 跑的 agent。執行 task：派 subagent、更新 task 狀態、處理 merge。 |
| subagent | orchestrator 自己派的子 agent，engine 看不到。 |
| runner | RunnerPort 的實作，spawn 某個 agent CLI。 |
| MCP facade | engine 提供給 agent 的 MCP 入口，背後呼叫 use case。 |
| run token | 每個 Run 發一個的 token，綁定該 item 與底下的 task，Run 結束就失效。 |
| M1 / M2 | M1 是 task 只是紀錄、由 orchestrator 自己排程。M2 是 engine 依賴圖排程 task，每個 task 一次 Run。v1 做 M1。 |

## 架構

| 名詞 | 意思 |
|---|---|
| port | application 層定義的介面，例如 StoragePort。 |
| adapter | port 的實作。 |
| driving adapter | 從外面呼叫 use case 的入口：REST、MCP、Poller。 |
| driven adapter | use case 往外呼叫的實作：storage、runtime store、runner、auth、clock。 |
| soft stop / hard stop | soft 是不再派新工作、目前這步做完就停。hard 是馬上終止。 |
