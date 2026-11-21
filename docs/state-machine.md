# State machine (item / task)

狀態名是 config 裡的邏輯名（kebab-case）。顯示名是 Title Case（`ready-to-split` 顯示成 `Ready to Split`）。
Jira / sqlite 的實際名稱靠 config 的 status mapping 對應，這份文件不管實際名稱。

名詞以 glossary.md 為準，欄位細節以 data-model.md 為準。

## Item

```mermaid
stateDiagram-v2
    direction LR
    state "refining" as Refining
    state "ready-to-split" as ReadyToSplit
    state "splitting" as Splitting
    state "needs-answers" as NeedsAnswers
    state "split-review" as SplitReview
    state "in-progress" as InProgress
    state "in-review" as InReview
    state "ready-to-rework" as ReadyToRework
    state "blocked" as Blocked
    state "done" as Done

    [*] --> Refining: human creates
    Refining --> ReadyToSplit: human
    ReadyToSplit --> Splitting: rule A claims
    Splitting --> SplitReview: succeeded (rule A or C)
    Splitting --> NeedsAnswers: needs_input (rule A)
    Splitting --> Blocked: failed or max_attempts
    Splitting --> ReadyToSplit: lease expired (rule A), attempt + 1
    Splitting --> ReadyToRework: lease expired (rule C), attempt + 1
    NeedsAnswers --> ReadyToSplit: human answers
    SplitReview --> InProgress: human approves
    SplitReview --> Refining: human sends back
    InProgress --> InReview: rule B succeeded
    InProgress --> Blocked: blocked_manual, needs_input, failed, max_attempts
    Blocked --> InProgress: auto-resume or human
    InReview --> Done: human accepts
    InReview --> ReadyToRework: human, feedback in comment
    ReadyToRework --> Splitting: rule C claims
    Done --> [*]
```

人可以把 item 從任何狀態移到任何狀態。特別注意 `blocked` 的出口不限於 `in-progress`，補完資料後可以直接拉去 `ready-to-rework`。

### 輪到誰

看板每欄標出接下來誰動（D68）：

- engine：有規則 `watch` 這個 status，從 config 算，沒掛規則就不標。
- 人：`needs-answers`、`split-review`、`in-review`、`blocked`。沒有規則會把 item 移出這幾欄。`blocked` 雖然有自動接回，前提是人先把 manual task 做完。
- 不標：`refining`（人自己在寫，不是在等確認）、claim status（卡片上已經有 Running）、`done`。

使用者在 config 讓規則 watch 一個「人」的 status 時，標 engine，因為 engine 會去撿。

### Auto-resume (`blocked` -> `in-progress`)

三個條件同時成立，engine 才自動接回：

1. 最近一次 Run 的 outcome 是 `blocked_manual`
2. 擋住的 manual task 都已經 `done`：讀成 item 底下已經沒有任何 `manual` 的 task。人把 manual 交回 `to-do` 也算，下一個 Run 會去做它（D71）
3. item 沒有 `hold`

engine 每輪 poll 在復原之後、認領之前檢查，接回到那條規則的 watch status，並留一則 system comment（D67）。目標不寫死：item 要在那條規則 `on.blocked_manual` 指的 status 上才接。

### Rules and outcomes

| rule | watch | claim status | succeeded | needs_input | blocked_manual | failed / max_attempts |
|---|---|---|---|---|---|---|
| A split | ready-to-split | splitting | split-review | needs-answers | n/a | blocked |
| B execute | in-progress | none (lease dedupes) | in-review | blocked | blocked | blocked |
| C rework | ready-to-rework | splitting | split-review | blocked | n/a | blocked |

- `cancelled` 的 Run 不動 status。item 停在原地，由人決定下一步。
- 規則 A 要能容忍 item 底下已經有 task（refine 階段建立的 manual task）。
- rework 的新 task 也要先過 `split-review`。想省掉這關，把規則 C 的 succeeded 出口改成 `in-progress`。

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
    InProgress --> InReview: subagent finished
    InReview --> Done: review passed
    InReview --> InProgress: review failed
    InProgress --> ToDo: Run over (engine), or stale
    ToDo --> Manual: human takes over
    InProgress --> Manual: human takes over
    Manual --> Done: human finished
    Manual --> ToDo: human hands back
    Done --> [*]
```

- `done` 是終點，engine 不重開，人也不行。rework 一律開新 task。
- 人走的邊只有四條：`to-do`、`in-progress` 接手成 `manual`，`manual` 交回 `to-do` 或做完成 `done`。不在這四條上的移動拒絕（domain 的 `personMoveRefusal`）。
- 人只能在 item 是 `split-review` 時改 task 的 title、body，或刪掉 task（D70）。
- 目前 orchestrator 一個 item 起一個 process（M1），engine 看不到裡面的 subagent。把執行中的 task 改成 `manual` 只是 soft stop，之後不再派它。要立刻停掉那張 task，只能 hard stop 整個 orchestrator。
- task 層的「review 沒過重做幾次」engine 管不到，由 orchestrator 的 prompt 約束。item 層用 Run 的重試次數與用量設上限。

## Invariants

這六條之後直接變成測試。

1. 同一張 item 同時最多一個存活的 Run。
2. item 的 status 只有三種來源能改：人、規則的 outcome、自動復原。agent 不能改。
3. `in-progress` 的 task 只有在 item 有存活的 Run 時才可信。Run 結束（`cancelled` 除外）或被 `abandoned` 時，engine 把它們送回 `to-do`（D69）。
4. `done` 的 task 不會被 engine 重開。
5. 有 `hold` 的 item，Poller 跳過它，存活的 Run 被取消。
6. `cancelled` 的 Run 不動任何 status。
