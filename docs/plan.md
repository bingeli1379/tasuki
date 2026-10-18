# Plan

狀態：草稿。

## v1 範圍

- engine：Poller、規則比對、Run 管理（lease、取消、復原）、結果驗證與轉移。
- tracker：sqlite 與 Jira Cloud。
- runner：claude-cli 為主，codex-cli 跟上。
- MCP facade（http）。
- REST API、auth（none、static、http）。
- 前端：kanban（讀取與拖拉移動）、item 詳情（task、comment、Run）、Run log、Stop 按鈕。
- CLI：`init`、`doctor`、`start`。
- 預設規則與預設 prompt。

## Non-goals（v1）

- M2：engine 依賴圖排程 task、單張 task 的 kill。
- plugin 載入機制（介面先在內部穩住，真的有第三方要寫再開放）。
- 多 instance、高可用。
- 角色與權限（RBAC）。
- Jira Data Center。
- engine 內建任何 git、GitHub、GitLab 功能，包含自動開 MR。
- sqlite 模式的指派與使用者系統。

## 里程碑

順序的原因：先把 core 與 sqlite 做到能完整跑，不依賴 Jira；Jira adapter 放在 storage 契約測試穩定之後。

| # | 內容 | 驗收 |
|---|---|---|
| M0 | pnpm workspace、TypeScript、Vite+（lint、format、type check、vitest、tsdown build）、CI | `pnpm test` 能跑，各 package 能 build |
| M1 | core：domain（WorkUnit、狀態機、規則比對、verdict 驗證）與 use case，搭配 in-memory 的假 adapter | state-machine.md 的每一列轉移、六條不變量都有測試；config 驗證規則都有測試 |
| M2 | sqlite tracker store、runtime store、Poller、假 runner | 端到端測試：item 從 `ready-to-split` 走到 `done`，用假 clock；lease 過期復原、hold、Stop、pause 都有測試 |
| M3 | claude-cli runner、MCP facade、run token | 在玩具 repo 上用真的 claude 手動煙霧測試；session resume 失敗會退回新 session；run token 的範圍有測試 |
| M4 | REST、auth、Vue SPA | kanban、item 詳情、Run log、Stop 可用；`none` 與 `static` 登入；ttl 過期測試 |
| M5 | Jira Cloud adapter、`doctor` | 與 sqlite adapter 共用同一套 StoragePort 契約測試；ADF 轉換 round-trip 測試；`doctor` 能報出不合法的 workflow 轉移；同一個端到端測試在 Jira 測試 project 上通過 |
| M6 | npm CLI 打包、container image、codex-cli runner、預設規則與 prompt | `init`、`doctor`、`start` 可用；container 可啟動；兩種 agent 都能跑完端到端 |

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

先記在這裡，做到對應里程碑再回來決定。

| 里程碑 | 要先定 | 為什麼卡 |
|---|---|---|
| M1 | `config-and-rules.md` 與 `agent-contract.md` 還是草稿 | config 驗證與 verdict 驗證的測試要照它們寫，欄位沒確認就寫等於寫兩次 |
| M2 | `attempt` 的歸零規則（待釐清 3） | `max_attempts` 會把 item 送進 `blocked`。人手動拉回來之後 attempt 要不要繼續累計，沒定就沒辦法寫那條復原測試 |
| M2 | `stop-and-recovery.md` 的數字：`leaseSeconds` 120、`softGraceSeconds` 300、`hardGraceSeconds` 10 | 都是草稿。用假 clock 測得出邏輯，但預設值要有依據 |
| M3 | 「待驗證」裡 headless CLI 那幾項：session resume、http MCP、取得 session id | 結果可能讓 runner 設計大改，例如只支援 stdio 時要加 shim |
| M4 | sqlite 模式下 refine 階段的互動式 agent 怎麼寫回 tracker（待釐清 5） | 要另外一個綁使用者身分的 MCP 入口，目前完全沒設計 |

## 待釐清（設計）

1. 規則 schema 的最終欄位（config-and-rules.md 是草稿）。
2. Jira 上 comment 的 author、kind 標記方式。
3. `attempt` 的歸零規則。
4. item 層的成本上限怎麼算、放哪裡。
5. sqlite 模式下，互動式 agent（refine 階段）怎麼寫回 tracker：需要 engine 另外提供綁使用者身分的 MCP 入口。
6. splitter 遇到 item 底下已經有 task（refine 階段建的 manual task、被打回後重拆）時的冪等準則，要寫進預設 prompt。
7. `Run` 是否要記 pid 或 process group，供 engine 重啟後清理殘留的 CLI process。
8. UI 的細節範圍（kanban 能不能直接改 status、能不能編輯 task）。
9. license。
10. webhook 驅動端。

## 待驗證（動手前對現行文件確認）

這些在設計時是憑印象寫的。

- `claude` 與 `codex` 的 headless 指令：輸出格式、session resume、工具白名單、注入 MCP 設定的方式。
- slash command 與 skill 在 headless 模式下能不能被呼叫。
- 兩個 CLI 是否支援 http 版的 MCP；只支援 stdio 時要不要加一個轉到 REST 的 shim。
- runner 怎麼取得 session id。
- agent preflight：怎麼偵測某個 CLI 裝了哪些 MCP server 與 skill。
- Jira Cloud：JQL 搜尋的現行 endpoint（這兩年改過版）、ADF 轉換的函式庫、comment property 是否可用、transitions API 的行為、API token 的 rate limit。
- sqlite driver：`better-sqlite3` 或內建的 `node:sqlite`。
- Sortie 的 adapter 介面與 SQLite schema（決定 D20 的待辦）。
- mermaid 圖在實際預覽下是否渲染正常（目前沒有在本機渲染驗證過）。
- Claude 與 Codex 的服務條款（訂閱帳號用於自動化與服務）。
