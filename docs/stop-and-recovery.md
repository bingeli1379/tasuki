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

後兩種靠偵測。每次 Poller tick 與 lease 續約時，engine 檢查每個存活的 Run：

- item 帶有 `hold`，或
- item 目前的 status 不是這個 Run 預期的（有 claim status 時是 claim status，沒有時是 watch status）

符合任一個就 `requestCancel(soft, by = 'human-override')`。

另外有一個全域的 pause，見下。

### 強度與機制

| | soft | hard |
|---|---|---|
| 意思 | 不再派新工作，目前這一步做完就停 | 馬上停 |
| 機制 | Run 標記取消，MCP 的寫入類 tool 回 `RUN_CANCELLED`，agent 讀到就收手 | 標記取消，並對整個 process tree 送 SIGTERM |
| 寬限 | 超過 `softGraceSeconds`（草稿：300）還沒結束，升級成 hard | 超過 `hardGraceSeconds`（草稿：10）還沒結束，送 SIGKILL |

取消後 Run 的 outcome 是 `cancelled`，item 的 status 不動。item 停在哪就在哪，由人決定下一步。

`hold` 被拿掉之後：

- item 停在 watch status（例如 `in-progress`）且沒有存活的 Run：Poller 會再起一個 Run，續跑。
- item 停在 claim status（例如 `splitting`）且沒有存活的 Run：復原機制把它送回 watch status，再被 Poller 撿起。

### M1 的限制

engine 只看得到 orchestrator 這一個 process，看不到裡面的 subagent。

- 把單張 task 改成 `manual` 只是 soft：之後不再派它，已經在跑的那一張會做完。
- 想立刻停掉某張 task，只能 hard stop 整個 orchestrator。它重啟後讀到那張 task 已經是 `manual`，就不會再動它。
- 精準到單張 task 的 kill 要等 M2。

### 全域 pause

`engine_state.paused` 為真時，Poller 不會開新的 Run。沒 token、要換 agent 設定、要維護時用。

- `pause`（預設）：讓執行中的 Run 自然跑完。
- `pause --kill`：對所有存活的 Run 送 hard cancel。

## Lease 與當機復原

- Run 建立時帶 `leaseUntil = now + leaseSeconds`（草稿：120 秒）。
- 執行中每 `leaseSeconds / 3` 續約一次。
- 每次 Poller tick 掃描：`state = running` 且 `leaseUntil < now` 的 Run，標成 `abandoned` 並結束，同一台機器上殘留的 process 一併終止。
- 啟動時先跑同一輪掃描。

item 在 Run 被 `abandoned` 之後怎麼處理：

| item 當時的 status | 處理 |
|---|---|
| claim status（例如 `splitting`） | 送回該 Run 那條規則的 watch status，`attempt + 1`。達到上限就走 `max_attempts` 的出口 |
| 沒有 claim 的 watch status（例如 `in-progress`） | 不動。Poller 下一輪會再起新的 Run，`attempt + 1` |
| task 還停在 `in-progress` | 不由 engine 處理。不變量 3：沒有存活 Run 的 `in-progress` task 不可信，orchestrator 重啟後當成 `to-do` |

被中斷的 workspace 會留著改到一半的檔案。engine 不清理，只有 `workspace.cleanup = on-done` 時在 item 完成後才刪。agent 續跑時要能接受這個狀態。

## 迴圈控制

- `maxAttempts` 以（item, rule）為單位計算，超過就走該規則 `on.max_attempts` 的出口，預設是 `blocked`。
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
