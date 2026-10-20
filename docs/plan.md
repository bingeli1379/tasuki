# Plan

狀態：草稿。

## 範圍

這份 plan 描述整個產品，不分版本。實作的順序只看下面的切片清單。

- engine：Poller、規則比對、Run 管理（lease、取消、復原）、結果驗證與轉移。
- plugin：tracker、runner、auth 三個角色都可以由第三方套件擴充。內建的 sqlite、Jira Cloud、claude-cli、codex-cli 走同一條路（D44，見 plugins.md）。
- MCP facade（http）。
- REST API、auth（none、static、http）。
- 前端：kanban（讀取與拖拉移動）、item 詳情（task、comment、Run）、Run log、Stop 按鈕。
- CLI：`init`、`doctor`、`start`。
- 預設規則與預設 prompt。
- engine 依賴圖排程 task、單張 task 的 kill（M2，見 glossary）。

## 刻意不做

- engine 內建任何 git、GitHub、GitLab 功能，包含自動開 MR（見 workspace-and-git.md）。

## 還沒決定要不要做

沒有排進切片，做不做、何時做都還沒決定。

- 多 instance、高可用。
- 角色與權限（RBAC）。
- sqlite 模式的指派與使用者系統。
- Jira Data Center 的 tracker。plugin 機制出來後，也可以由第三方提供。
- webhook 驅動端（待釐清 10）。

## 切片

文件描述整體設計，切片只決定做的順序。做法：一次做一個功能，從畫面一路做到 DB（web、REST、use case、port、sqlite），做完作者能在瀏覽器裡操作，再做下一個。core 只長出該切片需要的型別與規則，不預先寫整層。順序的原因與 M1 水平切層被丟掉的經過見 D41。

順序的原因：先把 sqlite 做到能完整跑，不依賴 Jira；Jira adapter 放在 sqlite 的行為穩定之後，用同一組場景驗證。

切片清單是草稿，做到再調。

| # | 切片 | 作者能看到的 |
|---|---|---|
| S0 | 骨架：web、server、sqlite、CI（已完成） | 瀏覽器開頁面，顯示 server 回報的 DB schema 版本 |
| S1 | 建立 item，在看板上看到。含最小的 config 載入與 plugin 載入（tracker 角色），內建 sqlite 也走這條路 | 新增 item，重新整理後還在，出現在 `refining` 欄 |
| S2 | 人移動 item 的 status | 拖拉或按鈕移動；兩邊同時改時顯示衝突 |
| S3 | item 詳情與 comment | 點開 item 看內容，留言 |
| S4 | 規則命中，假 runner 跑 split | `ready-to-split` 被認領、顯示 Run、結果轉移；lease 過期會復原 |
| S5 | task 與 `split-review` 放行 | 看到拆出的 task，人放行或打回 |
| S6 | execute：task 狀態與 verdict 驗證 | item 一路走到 `in-review`、`done` |
| S7 | hold、Stop、pause、blocked 自動接回、rework | 對應的按鈕與狀態變化 |
| S8 | 真的 claude runner（plugin）、MCP facade、run token | 在玩具 repo 上用真的 claude 跑一次 |
| S9 | auth（`none`、`static`、`http`） | 登入畫面、ttl 過期 |
| S10 | Jira Cloud tracker（plugin）、`doctor` | 同一組場景在 Jira 測試 project 上跑 |
| S11 | plugin 開發套件：`testkit` 對外發佈、範例 plugin、開發文件 | 照文件寫出一個第三方 tracker 並通過契約測試 |
| S12 | codex runner、npm CLI 打包、container image、預設 prompt | `init`、`doctor`、`start` 可用 |
| S13 | engine 依賴圖排程 task、單張 task 的 kill（M2） | 平行跑 task，單張 task 能被停掉 |

## 測試策略

- 狀態機與 verdict 驗證是純函式，用表格驅動測試，直接對應 state-machine.md 與 agent-contract.md 的表格。
- StoragePort 寫成契約測試，sqlite 與 Jira adapter 都要通過同一套。Jira 用測試 project 或錄製的 fixture。
- RunnerPort 用假 runner（腳本化的 agent 行為）做端到端，不呼叫真的 LLM。
- 時間一律走 `Clock`，lease 與 session ttl 用假時鐘撥快。
- 真 LLM 的測試只做手動煙霧測試，不進 CI。

## 風險

| 風險 | 影響 | 對策 |
|---|---|---|
| orchestrator 在 LLM 手上排程（M1） | 依賴順序與平行度不保證 | 驗證 verdict 時檢查 task 圖；M2 留好路 |
| Jira 的 workflow 不允許某些轉移 | 規則跑到一半失敗 | `doctor` 啟動前驗證 |
| headless 權限設定錯誤 | agent 卡住或權限過大 | `allowedTools` 白名單，雲端用容器 |
| ticket 內容夾帶指令 | agent 被誤導 | 見 security-and-auth.md |
| 訂閱帳號用在雲端服務的條款 | 帳號風險 | 雲端預設 API key，README 寫清楚 |
| 改到一半的 workspace | 續跑時狀態髒 | agent 要能接受，見 stop-and-recovery.md |

## 動工前要先定的

先記在這裡，做到對應切片再回來決定。

| 切片 | 要先定 | 為什麼卡 |
|---|---|---|
| S4 | `config-and-rules.md` 與 `agent-contract.md` 還是草稿 | 作者決定先寫 code，兩份文件等看過 code 再改成「已確認」。S4 是第一次真的讀規則，欄位在這時一定會被碰到 |
| S4 | `attempt` 的歸零規則（待釐清 3） | `max_attempts` 會把 item 送進 `blocked`。人手動拉回來之後 attempt 要不要繼續累計，沒定就沒辦法寫那條復原測試 |
| S4 | `stop-and-recovery.md` 的數字：`leaseSeconds` 120、`softGraceSeconds` 300、`hardGraceSeconds` 10 | 都是草稿。用假 clock 測得出邏輯，但預設值要有依據 |
| S8 | 「待驗證」裡 headless CLI 那幾項：session resume、http MCP、取得 session id | 結果可能讓 runner 設計大改，例如只支援 stdio 時要加 shim |
| S9 之前 | sqlite 模式下 refine 階段的互動式 agent 怎麼寫回 tracker（待釐清 5） | 要另外一個綁使用者身分的 MCP 入口，目前完全沒設計 |

## 待釐清（設計）

1. 規則 schema 的最終欄位（config-and-rules.md 是草稿）。
2. Jira 上 comment 的 author、kind 標記方式。
3. `attempt` 的歸零規則。D38 是當時的暫行做法，程式碼已隨 M1 丟掉，做到 S4 時重新確認。
4. item 層的成本上限怎麼算、放哪裡。
5. sqlite 模式下，互動式 agent（refine 階段）怎麼寫回 tracker：需要 engine 另外提供綁使用者身分的 MCP 入口。
6. splitter 遇到 item 底下已經有 task（refine 階段建的 manual task、被打回後重拆）時的冪等準則，要寫進預設 prompt。方向已定（D30）：engine 不判斷，由 agent 讀 item 裡的 task 與 comment 記錄自己決定有沒有拆過，prompt 的措辭 S8 再寫。
7. `Run` 是否要記 pid 或 process group，供 engine 重啟後清理殘留的 CLI process。
8. UI 的細節範圍（kanban 能不能直接改 status、能不能編輯 task）。
9. license。
10. webhook 驅動端。
11. 不變量 3（`in-progress` 的 task 只有 item 有存活 Run 時才可信）目前只靠 agent 遵守，engine 端沒有對應程式碼，測試只留了 `it.todo`。要不要由 engine 在 Run 結束時把殘留的 `in-progress` task 改回 `to-do`，或維持由 agent 處理？
12. 人能不能把 `done` 的 task 重開。task 圖沒有 `done` 的出口，實作時照圖，所有人都不行。
13. config 的 JSON Schema 怎麼產生。D28 的 `isolatedDeclarations` 要求每個 export 有明確型別，zod 這類 schema 物件很難滿足，所以傾向型別手寫。要補 `$schema` 給編輯器用時再決定（手寫、或從型別產生）。

## 待驗證（動手前對現行文件確認）

這些在設計時是憑印象寫的。

- `claude` 與 `codex` 的 headless 指令：輸出格式、session resume、工具白名單、注入 MCP 設定的方式。
- `claude` 與 `codex` 各自的 `api-key`、`oauth-token` 認證要吃哪個環境變數，以及 `allowedTools` 的名稱格式（D35）。
- slash command 與 skill 在 headless 模式下能不能被呼叫。
- 兩個 CLI 是否支援 http 版的 MCP；只支援 stdio 時要不要加一個轉到 REST 的 shim。
- runner 怎麼取得 session id。
- 長時間工具呼叫（例如跑測試）期間 CLI 有沒有輸出，決定 `idleTimeoutMinutes` 的預設值（D34）。
- agent preflight：怎麼偵測某個 CLI 裝了哪些 MCP server 與 skill。
- Jira Cloud：JQL 搜尋的現行 endpoint（這兩年改過版）、ADF 轉換的函式庫、comment property 是否可用、transitions API 的行為、API token 的 rate limit。
- Sortie 的 adapter 介面與 SQLite schema（決定 D20 的待辦）。
- mermaid 圖在實際預覽下是否渲染正常（目前沒有在本機渲染驗證過）。
- Claude 與 Codex 的服務條款（訂閱帳號用於自動化與服務）。
