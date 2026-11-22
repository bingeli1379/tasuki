# Stop and recovery

狀態：概念已確認，數字是草稿。

## 停止 AI

### 訊號

人有三種方式讓 AI 停：

| 訊號 | 強度 | 備註 |
|---|---|---|
| UI 的 Stop 按鈕（API） | hard | 針對某張 item 目前存活的 Run |
| 在 item 上貼 `hold` label | soft | 不需要 engine 專屬操作，Jira 上貼就行 |
| 把 item 移到別的 status | soft | Run 當初預期的 status 變了，視為人要接手 |

按 Stop 會同時貼上 `hold`。只砍 Run 的話，item 還在 watch status 或 claim status，下一輪就會被認領或被復原送回去重跑（D72）。在看板或使用者 MCP 貼 hold 時，有存活的 Run 就當場 soft cancel，不等下一輪。

直接在 Jira 貼 label 或移動 item 靠偵測。每次 Poller tick，engine 檢查每個存活的 Run（每張讀一次 tracker，沒有存活的 Run 就不讀）：

- item 帶有 `hold`，或
- item 目前的 status 不是這個 Run 預期的（有 claim status 時是 claim status，沒有時是 watch status）

符合任一個就 `requestCancel(soft, by)`，`by` 是 `hold` 或 `moved`。Stop 是 `requestCancel(hard, by = 'stop')`。一個 Run 只記第一次的時間。之後的 hard 會把 soft 升級，原因也換成 hard 的那個，因為是它把 Run 停掉的；反過來不會（D73）。

另外有一個全域的 pause，見下。

### 強度與機制

| | soft | hard |
|---|---|---|
| 意思 | 不再派新工作，目前這一步做完就停 | 馬上停 |
| 機制 | Run 標記取消，MCP 的寫入類 tool 回 `RUN_CANCELLED`，agent 讀到就收手 | 標記取消，並對整個 process tree 送 SIGTERM |
| 寬限 | 超過 `softGraceSeconds`（草稿：300）還沒結束，升級成 hard | 超過 `hardGraceSeconds`（草稿：10）還沒結束，送 SIGKILL |

取消與升級不靠 Poller：engine 每秒看一次本機的 runtime store（不碰 tracker），hard 的送 SIGTERM，soft 超過寬限就升級成 hard，SIGTERM 之後超過寬限送 SIGKILL。按下 Stop 到 agent 收到訊號最多一秒。

取消後 Run 的 outcome 是 `cancelled`，item 的 status 不動，task 也不送回（不變量 6）。item 停在哪就在哪，由人決定下一步。engine 留一則 system comment，寫是誰停的（Stop、hold、被移走）與 agent 的 summary。

`hold` 被拿掉之後：

- item 停在 watch status（例如 `in-progress`）且沒有存活的 Run：Poller 會再起一個 Run，續跑。
- item 停在 claim status（例如 `splitting`）且沒有存活的 Run：復原機制把它送回 watch status，再被 Poller 撿起。只看最近一次 Run 是被 Stop 或 hold 取消的 item，先問本機的 runtime store，沒有就不碰 tracker（core 的 `resumeReleased`）。

### M1 的限制

engine 只看得到 orchestrator 這一個 process，看不到裡面的 subagent。

- 把單張 task 改成 `manual` 只是 soft：之後不再派它，已經在跑的那一張會做完。
- 想立刻停掉某張 task，只能 hard stop 整個 orchestrator。它重啟後讀到那張 task 已經是 `manual`，就不會再動它。
- 精準到單張 task 的 kill 要等 M2。

### 全域 pause

`engine_state.paused` 為真時，Poller 不會開新的 Run。沒 token、要換 agent 設定、要維護時用。

- `pause`（預設）：讓執行中的 Run 自然跑完。
- `pause --kill`：對所有存活的 Run 送 hard cancel（`by = 'pause'`）。不貼 `hold`，恢復之後自己接著跑：停在 watch status 的直接被撿起，停在 claim status 的由 `resumeReleased` 送回 watch status（暫停中就先送回去等著）。

暫停只擋認領。lease 復原、偵測 hold 與移走、自動接回、取消與寬限都照跑，它們不會開新的 Run，停掉反而讓 item 卡在半路。旗標存在 runtime store，server 重開還是暫停的。看板上方有 Pause（含 Pause and stop all agents）與 Resume，暫停中顯示一條提示；使用者 MCP 是 `pause_engine`（`kill` 可選）與 `resume_engine`。CLI 的 `pause` 指令跟 S12 的 CLI 一起做，呼叫同一個 use case（D73）。

## Lease 與當機復原

- Run 建立時帶 `leaseUntil = now + leaseSeconds`（草稿：120 秒）。
- 執行中每 `leaseSeconds / 3` 續約一次。
- 每次 Poller tick 掃描：`state = running` 且 `leaseUntil < now` 的 Run，標成 `abandoned` 並結束，同一台機器上殘留的 process 一併終止。
- 啟動時先跑同一輪掃描。

item 在 Run 被 `abandoned` 之後怎麼處理：

| item 當時的 status | 處理 |
|---|---|
| claim status（例如 `splitting`） | 送回該 Run 那條規則的 watch status，`attempt + 1`。達到上限就走 `max_attempts` 的出口 |
| 沒有 claim 的 watch status（例如 `in-progress`） | 不動，留一則 comment 說下一輪再試。Poller 下一輪會再起新的 Run，`attempt + 1` |
| 已經不在 tracker（被人刪了） | Run 記成 `abandoned`，其他都不做。不擋下來的話，每一輪復原都會在這裡丟錯，後面的認領全部停擺（D69） |
| task 還停在 `in-progress` | 送回 `to-do`，每張留一則原因（不變量 3，D69）。Run 正常結束時也一樣，只有 `cancelled` 不動（不變量 6） |

被中斷的 workspace 會留著改到一半的檔案。engine 不清理，只有 `workspace.cleanup = on-done` 時在 item 完成後才刪。agent 續跑時要能接受這個狀態。

## 迴圈控制

- `maxAttempts` 以（item, rule）為單位計算，超過就走該規則 `outcomes.max_attempts` 的出口，預設是 `failure` 角色那站（預設流程的 `blocked`）。
- 每個 Run 有 `runTimeoutMinutes`，逾時視為 `failed` 並 hard stop。
- `limits.idleTimeoutMinutes` 不是 `null` 時，Run 的 `lastActivityAt` 距今超過它，處理方式與逾時相同：`failed` 並 hard stop，原因記為「沒有動靜」。預設 `null`（關閉）。lease 只證明 process 活著，這一條才抓得到「活著但卡死」。
- 預設關閉的原因：agent 執行長時間的工具呼叫（例如跑一輪測試）期間，CLI 可能完全沒有輸出，會被誤殺。實際行為待 M3 驗證（見 plan.md 待驗證），之後再決定預設值。
- 人在 loop 裡的來回（`needs-answers` 與 `ready-to-split`、`ready-to-rework` 與 `in-review`）由人控制，engine 不設上限。
- attempt 怎麼累計見 D38。item 層的成本上限還沒定（見 plan.md）。

## 人與 engine 同時改

人永遠優先。

- 所有 status 轉移都用 compare-and-set：`transition(ref, expectedFrom, to)`。目前 status 不等於 `expectedFrom` 就丟 `StatusConflict`。
- engine 收到 `StatusConflict`，當作人剛剛動過這張 item：對存活的 Run 做 soft cancel，並且不再寫入結果轉移。
- Jira 沒有原子的條件式轉移，所以是「轉移前馬上重讀一次 status」，視窗很小，接受這個殘餘風險。
- orchestrator 每次派下一張 task 之前都重新讀一次 task 狀態（見 agent-contract.md）。
