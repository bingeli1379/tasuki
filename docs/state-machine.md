# State machine (item / task)

狀態名是流程設定裡的邏輯名（kebab-case）。顯示名是 Title Case（`ready-to-split` 顯示成 `Ready to Split`）。
Jira / sqlite 的實際名稱靠流程設定的 status mapping 對應，這份文件不管實際名稱。

名詞以 glossary.md 為準，欄位細節以 data-model.md 為準。

下面的十站是預設流程。站可以在設定頁的流程設定裡自己列（D91），程式只認角色不認名字（D78、D81）：`entry` 是 `refining`、`failure` 是 `blocked`。`ready-to-rework` 的「打回要先寫回饋」來自 rework 規則盯它，不是角色（D86）。這份文件寫到站名的地方，換了流程就讀成扮演那個角色的站。

## Item

```mermaid
stateDiagram-v2
    direction LR
    state "refining" as Refining
    state "ready-to-split" as ReadyToSplit
    state "needs-answers" as NeedsAnswers
    state "split-review" as SplitReview
    state "in-progress" as InProgress
    state "in-review" as InReview
    state "ready-to-rework" as ReadyToRework
    state "blocked" as Blocked
    state "done" as Done

    [*] --> Refining: human creates
    Refining --> ReadyToSplit: human
    ReadyToSplit --> SplitReview: rule A succeeded
    ReadyToSplit --> NeedsAnswers: rule A needs_input
    ReadyToSplit --> Blocked: rule A failed or max_attempts
    NeedsAnswers --> ReadyToSplit: human answers
    SplitReview --> InProgress: human approves
    SplitReview --> Refining: human sends back
    InProgress --> InReview: rule B succeeded
    InProgress --> Blocked: blocked_manual, needs_input, failed, max_attempts
    Blocked --> InProgress: auto-resume or human
    InReview --> Done: human accepts
    InReview --> ReadyToRework: human, feedback in comment
    ReadyToRework --> SplitReview: rule C succeeded
    ReadyToRework --> Blocked: rule C needs_input, failed, max_attempts
    Done --> [*]
```

預設規則都不設 claim status：agent 跑的時候 item 留在 watch status，卡片掛 Running，lease 防重複（D74）。`splitting` 是選用的 claim status，規則設了 `claim: splitting` 才用得到，那時 item 會先被移進 `splitting`，結束時從那裡走出口，lease 過期就送回該規則的 watch status。

人可以把 item 從任何狀態移到任何狀態。特別注意 `blocked` 的出口不限於 `in-progress`，補完資料後可以直接拉去 `ready-to-rework`。

### 誰處理

看板每欄標出這站誰處理（D68，D81 改名 `handledBy`）：

- engine：有規則 `watch` 這個 status，從規則算，沒掛規則就不標。
- 人：站設了 `handledBy: "person"`。預設流程是 `needs-answers`、`split-review`、`in-review`、`blocked`，沒有規則會把 item 移出這幾欄。`blocked` 雖然有自動接回，前提是人先把 manual task 做完。
- 不標：兩者都沒有。預設流程是 `refining`（人自己在寫，不是在等確認）、claim status（卡片上已經有 Running）、`done`。

卡片另外標兩種狀態：agent 正在跑時外框有繞圈的藍光與 Running；最新一次 Run 以 `failed` 或 `max_attempts` 把 item 送來、而且它還在那站時，外框變紅並標 Failed 或 Gave up after N tries，人移走或下一次 Run 開跑就不標（D93）。

一站設了 `handledBy: "person"` 又被規則 watch 時，標 engine，因為 engine 會去撿。

人在詳情看到的決定按鈕是站上的 `outcomes`，按下去就是移到那一站。預設流程只有兩站有：`split-review` 是 `→ Refining` 與 `→ In Progress`，`in-review` 是 `→ Ready to Rework` 與 `→ Done`。按鈕字用中性的「箭頭加目標站」，不寫死批准、打回這類動作（D82）。

### Auto-resume (`blocked` -> `in-progress`)

三個條件同時成立，engine 才自動接回：

1. 最近一次 Run 的 outcome 是 `blocked_manual`
2. 擋住的 manual task 都已經 `done`：讀成 item 底下已經沒有任何 `manual` 的 task。人把 manual 交回 `to-do` 也算，下一個 Run 會去做它（D71）
3. item 沒有 `hold`

engine 每輪 poll 在復原之後、認領之前檢查，接回到那條規則的 watch status，並留一則 system comment（D67）。目標不寫死：item 要在那條規則 `outcomes.blocked_manual` 指的 status 上才接。

### Rules and outcomes

| rule | watch | claim status | succeeded | needs_input | blocked_manual | failed / max_attempts |
|---|---|---|---|---|---|---|
| A split | ready-to-split | none (lease dedupes) | split-review | needs-answers | n/a | blocked |
| B execute | in-progress | none (lease dedupes) | in-review | blocked | blocked | blocked |
| C rework | ready-to-rework | none (lease dedupes) | split-review | blocked | n/a | blocked |
| D dispatch（選用，取代 B） | in-progress | none (one Run per task) | in-review | n/a | blocked | n/a |

- 表上是預設規則。每條規則的出口由它的 `outcomes` 決定，也可以宣告自己的結果，例如一條 `review` 規則的 `approve` 與 `changes`，item 照表去對應的站（config-and-rules.md，D84）。
- `cancelled` 的 Run 不動 status。item 停在原地，由人決定下一步。按 Stop 會順手貼上 `hold`，不然下一輪又會被認領（D72）。`hold` 拿掉後，停在 claim status 的 item 由 engine 送回 watch status，停在 watch status 的直接被 Poller 撿起。
- 規則 A 要能容忍 item 底下已經有 task（refine 階段建立的 manual task）。
- rework 要有人說改什麼才開跑：上一個 Run 結束之後，item 上要有一則人寫的 note。看板拖進 `ready-to-rework` 或從詳情移過去都會先問，使用者 MCP 的 `request_rework` 強制要寫；在 Jira 直接拖過去又沒留言的，engine 不派 agent，走規則的 `needs_input` 出口（預設 `blocked`）並留言請人補上（D75）。
- rework 的新 task 也要先過 `split-review`。想省掉這關，把規則 C 的 succeeded 出口改成 `in-progress`。

### Dispatch（M2）

`dispatch` 規則跟 B 一樣盯 `in-progress`，差在誰派 task（D102）。B 起一個 orchestrator，由它自己排 task；dispatch 由 engine 照 task 圖排，一張 task 一個 Run（target 是那張 task），agent 只做那一張。兩種擇一，`watch` 不能重複本來就擋掉兩條規則同時盯一站。

每輪 poll 的認領那一步：

1. 找可跑的 task：`to-do`，或 `in-progress` 但沒有存活的 Run（過期的），而且 blockedBy 全部 `done`。
2. 照建立順序各起一個 Run，跟其他 Run 一起受 `limits.maxConcurrentRuns` 限制。認領時 engine 把 task 移到 `in-progress`。
3. task 的 Run 結束時，engine 照 verdict 移那張 task：`succeeded` 到 `done`；`failed`、沒有 verdict、`abandoned` 回 `to-do`，下一輪再派；`needs_input` 到 `manual`，agent 留的 question 就是要人決定的事。同一張 task 的 attempt 到規則的 `maxAttempts` 也轉 `manual`，留一則原因。
4. item 底下沒有存活的 task Run 時，engine 判斷 item 的出口：task 全部 `done`（沒有 task 也算）走 `outcomes.succeeded`；沒有可跑的 task、但還有沒 done 的 `manual`，走 `outcomes.blocked_manual`。兩個都不是就等下一輪。

item 的出口沒有 agent，engine 照 `max_attempts` 的做法（D38）記一筆不起 process 的 Run，outcome 就是那個出口。所以自動接回的第 1 條、卡片的 Failed 標示都照舊讀「最近一次 Run」。

dispatch 的 item 永遠走不到 `needs_input`、`failed`、`max_attempts`：task 出事會變成 `manual`，最後由 `blocked_manual` 送去 `blocked`。

## Task

```mermaid
stateDiagram-v2
    direction LR
    state "to-do" as ToDo
    state "in-progress" as InProgress
    state "in-review" as InReview
    state "manual" as Manual
    state "done" as Done

    [*] --> Manual: created at refine (origin = refine)
    [*] --> ToDo: created by splitter (origin = splitter)
    ToDo --> InProgress: dispatched, all blockedBy done
    InProgress --> InReview: subagent finished (execute)
    InReview --> Done: review passed
    InReview --> InProgress: review failed
    InProgress --> Done: task Run succeeded (dispatch)
    InProgress --> ToDo: Run over (engine), or stale
    ToDo --> Manual: human takes over
    InProgress --> Manual: human takes over or Stop, needs_input or max attempts (dispatch)
    Manual --> Done: human finished
    Manual --> ToDo: human hands back
    Done --> ToDo: human reopens, no live Run
    Done --> Manual: human reopens, no live Run
    Done --> [*]
```

- engine 不重開 `done`，agent 也不行。rework 一律開新 task。
- 人走的邊：`to-do`、`in-progress` 接手成 `manual`，`manual` 交回 `to-do` 或做完成 `done`，按錯時把 `done` 改回 `to-do` 或 `manual`。改回去只在 item 沒有存活的 Run 時可以，agent 可能正依賴它是 done（D74）。不在這些邊上的移動拒絕（domain 的 `personMoveRefusal`）。
- 人在看板或使用者 MCP 的每個操作（移動 item 或 task、hold、release、Stop）都留一則 author 是人、kind 是 `system` 的 comment，例如「Moved **Manual** → **Done**.」（D82）。誰、什麼時候由 comment 本身記著。用 `system` 不用 `note`，因為 rework 的 agent 把人最新的 note 當成回饋（D74）。
- 人改 task 的 title、body 或刪掉 task，只在 item 沒有存活的 Run 時可以，在哪一站都行。有 agent 在跑就先 Stop（D86，原本只限 `split-review`，D70）。
- execute（M1）一個 item 起一個 orchestrator，engine 看不到裡面的 subagent。把執行中的 task 改成 `manual` 只是 soft stop，之後不再派它。要立刻停掉那張 task，只能 hard stop 整個 orchestrator。dispatch（M2）每張 task 是自己的 Run，可以只停那一張（stop-and-recovery.md）。
- task 層重做幾次：execute 由 orchestrator 的 prompt 約束，engine 管不到；dispatch 是每張 task 的 attempt 加上規則的 `maxAttempts`。item 層用 Run 的重試次數與用量設上限。
- dispatch 不走 `in-review`：agent 回報 `succeeded`，engine 直接把 task 移到 `done`。要 AI 審 task，在 task 的 prompt 裡自己審，或在 item 層加一站 `review` 規則。

## Invariants

這六條之後直接變成測試。

1. 同一個 target（item 或 task）同時最多一個存活的 Run。一張 item 自己的 Run 與它底下 task 的 Run 不會同時存活：item 底下還有存活的 task Run 時，engine 不認領那張 item。
2. item 的 status 只有三種來源能改：人、規則的 outcome、自動復原。agent 不能改。
3. `in-progress` 的 task 只有在有存活的 Run 負責它時才可信：execute 是 item 的 Run，dispatch 是那張 task 自己的 Run。item 的 Run 結束（`cancelled` 除外）或被 `abandoned` 時，engine 把殘留的送回 `to-do`（D69）；dispatch 的 task Run 照上面的 verdict 處理，dispatch 認領時也把沒人負責的 `in-progress` 當成 `to-do`。
4. `done` 的 task 不會被 engine 或 agent 重開。人可以，但只在 item 沒有存活的 Run 時（D74）。
5. 有 `hold` 的 item，Poller 跳過它，存活的 Run 被取消。
6. `cancelled` 的 Run 不動任何 status。按 task 上的 Stop 時 task 轉 `manual`，那是人的操作，不是 Run 的結果（D102）。
