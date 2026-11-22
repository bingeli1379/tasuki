# Plan

狀態：草稿。

## 範圍

這份 plan 描述整個產品，不分版本。實作的順序只看下面的切片清單。

- engine：Poller、規則比對、Run 管理（lease、取消、復原）、結果驗證與轉移。
- plugin：tracker、store、runner、auth 四個角色都可以由第三方套件擴充。內建的 sqlite、Jira Cloud、claude-cli、codex-cli 走同一條路（D44，見 plugins.md）。
- MCP facade（http）。
- REST API、auth（不登入、`auth-builtin`、`auth-http`）與 access（`admin`、`maintainer`、`member`）。
- 前端：kanban（讀取與拖拉移動）、item 詳情（task、comment、Run）、Run log、Stop 按鈕。
- CLI：`init`、`doctor`、`start`。
- 預設規則與預設 prompt。
- engine 依賴圖排程 task、單張 task 的 kill（M2，見 glossary）。

## 刻意不做

- engine 內建任何 git、GitHub、GitLab 功能，包含自動開 MR（見 workspace-and-git.md）。

## 還沒決定要不要做

沒有排進切片，做不做、何時做都還沒決定。

- 多 instance、高可用。一個 tracker project 只接一個 engine，要更多 agent 往 runner 擴（D66）。
- sqlite 模式的指派與使用者系統。
- Jira Data Center 的 tracker。plugin 機制出來後，也可以由第三方提供。
- webhook 驅動端（待釐清 10）。

## 切片

文件描述整體設計，切片只決定做的順序。做法：一次做一個功能，從畫面一路做到 DB（web、REST、use case、port、sqlite），做完作者能在瀏覽器裡操作，再做下一個。core 只長出該切片需要的型別與規則，不預先寫整層。順序的原因與 M1 水平切層被丟掉的經過見 D41。

每個切片的 tracker 部分 sqlite 與 Jira Cloud 一起做，用同一組契約測試驗兩邊，兩邊都能在瀏覽器操作才算完成（D47）。

切片清單是草稿，做到再調。

| # | 切片 | 作者能看到的 |
|---|---|---|
| S0 | 骨架：web、server、sqlite、CI（已完成） | 瀏覽器開頁面，顯示 server 回報的 DB schema 版本 |
| S1 | 建立 item，在看板上看到。含最小的 config 載入、`.env`、plugin 載入（tracker 角色），內建的 `sqlite` 與 `jira-cloud` 都走這條路（已完成） | 新增 item，重新整理後還在，出現在 `refining` 欄；sqlite 與 Jira 測試 project 各做一次 |
| S2 | 人移動 item 的 status（已完成） | 拖拉或按鈕移動；兩邊同時改時顯示衝突 |
| S3 | item 詳情與 comment，含編輯 title 與 body、markdown、附件（已完成，D61） | 點開 item 看內容、改內容、貼圖、留言 |
| S4 | 規則命中，假 runner 跑 split（已完成，D63） | `ready-to-split` 被認領、顯示 Run、結果轉移；lease 過期會復原 |
| S5 | task 與 `split-review` 放行（已完成，D65） | 看到拆出的 task，人放行或打回 |
| S6 | execute：task 狀態與 verdict 驗證（已完成，D69） | item 一路走到 `in-review`、`done` |
| S7a | task 詳情（內文與 comment，含 D67 的原因）、人改 task status（接手、交回、manual 做完）、在 `split-review` 編輯與刪除 task（已完成，D70） | 點開 task 看內容與原因；不用重拆就能修 task |
| S7b | blocked 自動接回、規則 C rework、`in-review` 打回 `ready-to-rework` 的按鈕（已完成，D71） | manual 做完後 item 自己回 `in-progress`；打回後重拆、再進 `split-review` |
| S7c | Stop（hard）、hold（soft）、人移走 item 視為接手、`RUN_CANCELLED`、soft 與 hard 的寬限升級（已完成，D72） | 按 Stop 後 Run 變 cancelled；貼 hold 後 engine 不碰它 |
| S7d | 全域 pause 與 `pause --kill`（已完成，D73；CLI 指令跟 S12 一起） | 暫停後不再起新的 Run |
| S7e | 作者試用 S7 後的回饋：預設規則不用 claim status、刪除 item、人可以改回 done 的 task、人的操作留紀錄、看板與詳情的使用性、沒有回饋的 rework 不開跑（已完成，D74、D75） | 卡片留在原欄掛 Running；按錯能改回；詳情秒開、跟著看板更新 |
| S8 | 真的 claude runner（plugin）、規則的 prompt 與 session、預設 prompt（MCP facade 與 run token 在 S4 就有了）（已完成，D76）。之後補了 prompt 三層與 agent 自帶 plugin、MCP（D77） | 在玩具 repo 上用真的 claude 跑一次 |
| W1 | status 自訂與角色、`handledBy`、站上給人的 `outcomes`，還在檔案裡設定（已完成，D78、D81，custom-workflow.md） | config 加一站，看板多一欄，眼睛和雷達標對 |
| W2 | 規則宣告 `outcomes`（`on` 併進來）、`review` mode（已完成，D84） | 加一站 AI review，agent 依結果把 item 送到不同地方 |
| W3 | store 變成 plugin 角色，sqlite 搬過去，`testkit` 加 store 契約（已完成，D88） | 行為不變，契約測試多一套 |
| S9a | `auth-builtin`、access 與帳號管理、setup token、session cookie 與 CSRF、登入防暴力、`Host` 檢查、`/mcp` 的個人 API token（已完成，D60、D89） | 用 log 裡的 setup token 建第一個 admin、建帳號、改 access、ttl 過期或改 ttl 被踢回登入頁、沒登入打 API 被拒；產生 token 貼進 Claude Code，撤銷後 401 |
| S9c | `auth-http`、開放非 loopback 綁定（`publicUrl`、`allowInsecure`）（已完成，D89、D90） | setup 連結建第一個 admin；admin 貼一串 username 加人，名單上的人用外部帳號登入，刪掉的進不來 |
| W4a | 流程設定（站、角色、task status 對照、規則與 prompt、hold label）進 store，設定頁用表單（只給 `admin` 與 `maintainer`）、熱重載；agent、poll、limits 留在檔案（已完成，D91） | 在網頁上加一站、改規則的 prompt，下一輪就生效；存檔不合法時看到錯在哪 |
| W4b | 流程設定的修改歷史、回到任一版（已完成，D91、D94） | 看得到誰在什麼時候改了什麼，能回到前一版 |
| S10 | `doctor`，含擋第二個 engine 的心跳（已完成，D66、D95） | 啟動前列出 config、plugin、Jira workflow 的問題；同一個 project 已經有別的 engine 在跑時拒絕啟動 |
| S11 | plugin 開發套件：`testkit` 對外發佈、範例 plugin、開發文件 | 照文件寫出一個第三方 tracker 並通過契約測試 |
| S12 | codex runner、npm CLI 打包、container image | `init`、`doctor`、`start` 可用 |
| S13 | engine 依賴圖排程 task、單張 task 的 kill（M2） | 平行跑 task，單張 task 能被停掉 |

## 測試策略

- 狀態機與 verdict 驗證是純函式，用表格驅動測試，直接對應 state-machine.md 與 agent-contract.md 的表格。
- TrackerPort 與 StorePort 寫成契約測試，tracker 的 sqlite 與 Jira、store 的 sqlite 各自通過同一套。Jira 用測試 project 或錄製的 fixture。
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
| Jira 附件的 media id 靠下載轉址網址取得，不是公開 API（D61） | Atlassian 改了格式，就不能在 body 插新圖 | 存檔時報錯、不寫入，資料不會壞；契約測試每次都走這條路，改了會先在本機發現 |

## 動工前要先定的

先記在這裡，做到對應切片再回來決定。

| 切片 | 要先定 | 為什麼卡 |
|---|---|---|
| S8 | `stop-and-recovery.md` 的數字：`leaseSeconds` 120、`softGraceSeconds` 300、`hardGraceSeconds` 10 | 都是草稿。S4 先照草稿當預設值，邏輯用假 clock 測過；接上真的 claude 後，用實際的輸出間隔回頭調 |

## 待釐清（設計）

1. 規則 schema 的最終欄位（config-and-rules.md 是草稿）。
2. （已定，D61）Jira 上 comment 的 author、kind：agent 與 engine 的 comment 帶 comment property 加一行看得見的標記，沒有 property 的是人寫的。
3. （已定，D38）`attempt` 的歸零規則：只有 `abandoned` 之後累計，`max_attempts` 也記成一筆 Run，人拉回來就從 1 重算。
4. item 層的成本上限怎麼算、放哪裡。
5. （已定，D57）sqlite 模式下，互動式 agent（refine 階段）怎麼寫回 tracker：engine 在 `/mcp` 提供綁使用者身分的 MCP，Claude Code 與 Codex 都能接。
6. （已定，D30、D76）splitter 遇到 item 底下已經有 task 時的冪等準則：engine 不判斷，預設 prompt 叫 agent 保留現有的 task、只補缺的。
7. `Run` 是否要記 pid 或 process group，供 engine 重啟後清理殘留的 CLI process。
8. （已定）UI 的細節範圍：kanban 直接改 status（S2）；task 在 `split-review` 能改 title、body 與刪除，blockedBy 不能改（D70）。
9. license。
10. webhook 驅動端。
11. （已定，D69）不變量 3：Run 結束（`cancelled` 除外）或被 `abandoned` 時，engine 把殘留的 `in-progress` task 送回 `to-do`，每張留一則原因。
12. （已定，D70，D74 改）engine 與 agent 不重開 `done` 的 task。人可以改回 `to-do` 或 `manual`，但只在 item 沒有存活的 Run 時。
13. config 的 JSON Schema 怎麼產生。D28 的 `isolatedDeclarations` 要求每個 export 有明確型別，zod 這類 schema 物件很難滿足，所以傾向型別手寫。要補 `$schema` 給編輯器用時再決定（手寫、或從型別產生）。
14. config 與 Jira 的 workflow 不同步。sqlite 的 status 完全由 config 決定，改 config 就生效；Jira 的 status、轉移、issue type 在 Jira 那邊，config 改了 Jira 不會跟著變。`doctor` 已經會列出 workflow 不允許的轉移，與沒有放進任何一欄的 status（D95）；還沒做的是下面的代為去改與欄位順序。方向：`init` 或 `doctor` 發現對不上時，問使用者要不要代為去改 Jira。目前測試 project 先手動設定，功能做完後回來處理。team-managed 的 workflow 可以用 `POST /workflows/update` 改，S2 設定 KAN 時用過（D59）。Jira 看板的欄位也要一起檢查：`doctor` 用公開的 `GET /rest/agile/1.0/board/{id}/configuration` 比對，tasuki 用到的 status 沒有出現在任何一欄就警告（那些卡片在 Jira 看板上會看不到），欄位順序跟 state-machine.md 不同也提示。公開 API 不能改看板欄位，所以順序對不上時問使用者要不要「試著」自動排：用 Jira 網頁自己用的內部 API `PUT /rest/greenhopper/1.0/rapidviewconfig/columns`（2026-11-20 在 KAN 的 team-managed 看板上試過，回 500 但順序已經存進去），排完重讀一次確認；失敗或結果不對，就退回列出正確順序請使用者自己拖。內部 API 沒有文件、隨時會變，不能當成唯一的路。

15. 看板大量 item 的效能：Done 欄只會越來越長，看板與 `list_board` 目前整包讀回、沒有虛擬滾動，卡片又能拖拉。要不要分頁、收合或虛擬滾動，還沒定（S9c 討論時提出）。

## 待驗證（動手前對現行文件確認）

這些在設計時是憑印象寫的。

- `claude -p` 用 `--resume` 接回一段快滿的對話時，會不會自己壓縮（auto-compact）。`session: per-item` 的規則接了很多次之後要靠它；不會的話，要讓 runner 在 token 用量太高時改開新對話，或同一張卡接了 N 次就重開（作者 2026-11-22 提出）。

- `codex` 的 headless 指令：輸出格式、session resume、工具白名單、注入 MCP 設定的方式。`claude` 已在 S8 用 2.1.323 驗過（D76）：`-p --output-format stream-json --verbose`、`--session-id` 自訂 uuid、`--resume`（找不到時 exit 1）、`--mcp-config` 給 http server 帶 header、`--allowedTools` 的格式是 `mcp__<server>` 與 `Bash(git:*)`。
- `claude` 與 `codex` 各自的 `api-key`、`oauth-token` 認證要吃哪個環境變數（D35）。claude-cli 目前只做 `inherit-login`。
- codex 是否支援 http 版的 MCP；只支援 stdio 時要不要加一個轉到 REST 的 shim。claude 支援（D76）。
- 長時間工具呼叫（例如跑測試）期間 CLI 有沒有輸出，決定 `idleTimeoutMinutes` 的預設值（D34）。
- agent preflight：怎麼偵測某個 CLI 裝了哪些 MCP server 與 skill。claude 已在 S10 做成 `doctor` 第 9 條（D95）：stream-json 的 `init` 列出 `skills` 與帶 `status` 的 `mcp_servers`，不一定是第一行。codex 還沒查。
- 使用者 MCP 接 Codex（D57）：2026-11-16 用 codex-cli 0.169.0 驗過 `initialize` 與 `tools/list`（中間放 proxy 記錄請求），`tools/call` 沒驗，因為手上沒有 Codex 帳號，模型叫不起來。Claude Code 2.1.311 已實際呼叫 `create_item` 與 `list_board` 成功。
- Jira Cloud：API token 的 rate limit。transitions API 已在 S2 實際走過（D59）；ADF 轉換（marklassian 加自寫的反向）與 comment property 已在 S3 實際走過（D61）。
- Sortie 的 adapter 介面與 SQLite schema（決定 D20 的待辦）。
- mermaid 圖在實際預覽下是否渲染正常（目前沒有在本機渲染驗證過）。
- Claude 與 Codex 的服務條款（訂閱帳號用於自動化與服務）。
