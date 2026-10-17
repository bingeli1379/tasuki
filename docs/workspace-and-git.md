# Workspace and git

狀態：已確認。

## 分工

git 策略算實作，會因人而異，所以 engine 不管 git。engine 只負責一件事：給每張 item 一個獨立的工作目錄。

| | engine | agent / skill |
|---|---|---|
| 建立 `<workspace.root>/<ITEM-KEY>/` | ✓ | |
| 當成 Run 的 cwd，並用 `SDD_WORKSPACE` 傳給 agent | ✓ | |
| 記錄在 `Run.workspace` | ✓ | |
| item 完成後依 `workspace.cleanup` 決定要不要刪 | ✓ | |
| 決定要改哪些 repo | | ✓（refine 階段的 item 內容會寫） |
| clone、開 branch、開 worktree、commit、merge、push | | ✓ |
| 開 MR | | 可選，不強制 |

這樣能撐住兩件事：一張 item 會動到多個專案，以及多張 item 平行跑時不會在同一份 checkout 上互相踩到。

## 預設的 branch 慣例

這是 skill 的預設行為，不是 engine 的功能。

- item branch：`feature/<ITEM-KEY>`，例如 `feature/PROJ-123`。
- task branch：`task/<TASK-KEY>`，例如 `task/PROJ-124`。
- task 做完 merge 回 item branch，由 orchestrator 執行。
- 一張 item 動到多個 repo 時，每個 repo 都用同樣的 branch 名稱。
- 不開 MR 也可以。agent 預設只做兩件事：確保各 repo 的 item branch 就緒，並在 item 上留一則 comment 列出 branch 名，供人 review。

兩個限制：

1. 不能巢狀命名。git 不允許 `feature/PROJ-123` 與 `feature/PROJ-123/PROJ-124` 同時存在，因為 ref 是檔案，不能同時又是目錄。所以 task 用 `task/` 前綴，不放在 item branch 底下。
2. task 各開 branch 又要平行跑，每個 task 都需要自己的 worktree，同一份 checkout 切不了兩個 branch。不用 worktree 的話 task 只能循序執行。

merge 衝突要有固定的出路：orchestrator 回報 `blocked_manual`（或 `failed`），item 進 `blocked`，engine 寫一則 `system` comment 說明哪個 task 與誰衝突。

## 目錄示意

```
<workspace.root>/
  PROJ-123/                     # cwd for every Run of this item
    repoA/                      # worktree on feature/PROJ-123
    repoA.task-PROJ-124/        # worktree on task/PROJ-124
    repoB/
```

原始 clone 放哪裡（例如 `~/Project/<repo>`）是 skill 的事，worktree 從那裡建出來。上面的目錄命名只是建議。
