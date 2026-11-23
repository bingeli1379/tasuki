# 自訂流程（草稿）

讓每個人、每個團隊自己定義 item 的 stage、每一站做什麼、做完去哪，並且在前端介面上改，不用改程式。方向已定（D78），W1、W2 已做完（D81、D84），其餘切片排進了 plan.md。定案的部分會搬進 state-machine.md、config-and-rules.md、data-model.md、plugins.md，這份到時刪掉。

## 現況與缺口

- 能自訂的：規則盯哪一站（`watch`）、派哪個 agent、給什麼 prompt（D77 的三層）、每個 status 對到 tracker 的哪個 key。
- W1 之後能自訂的：item 的 status、順序、顯示名、誰處理（`handledBy`）、人在每站的按鈕（`outcomes`）、兩個角色（D81，D86 從五個減成兩個）。
- W2 之後能自訂的：規則有哪些結果、各去哪一站（規則的 `outcomes`），多了只讀與留言的 `review` mode（D84）。
- config 只能寫在檔案裡，改了要重啟，前端看不到也改不了（W4a 把流程設定搬進 store、加了設定頁，D91）。
- store 寫死是 sqlite，第三方沒辦法換成別的 DB（W3 改成 plugin，D88）。

## 1. stage 的三種

| 種類 | 誰動 | 看板 | 怎麼決定 |
|---|---|---|---|
| 靜態 | 沒人在等 | 不標 | 預設 |
| 等人 | 人 | 眼睛 | status 設 `handledBy: "person"`（D81，原本叫 `waitsFor`） |
| engine | engine 撿起來交給 agent | 雷達 | 有規則 `watch` 它，從規則算，不用另外標 |

這就是 D68「輪到誰」的一般化：現在「人」的那幾欄是寫死的清單（`needs-answers`、`split-review`、`in-review`、`blocked`），改成每個 status 自己的旗標。一個 status 同時設了 `handledBy: "person"` 又被規則 watch 時，照 D68 標 engine。

## 2. status 自訂，特殊用途改成角色

status 整串由使用者列。程式裡會點名某個 item status 的地方，都是因為那一站有特殊用途，這些用途改成角色，由使用者指定哪一站扮演。engine 與看板只認角色，不認名字。

| 角色 | 現在是 | 程式靠它做什麼 | 必填 |
|---|---|---|---|
| `entry` | `refining` | 新 item 從這裡開始 | 是 |
| `failure` | `blocked` | 規則沒寫 `needs_input`、`failed`、`max_attempts` 出口時的預設去處 | 是 |

- 原本還有三個，D86 拿掉：`done` 沒有程式在讀；`taskReview`（只有這站能改 task）換成「item 沒有 agent 在跑時才能改 task」；`rework`（送進來要先寫回饋，D75）不給手寫，從 rework 規則 `watch` 的那站算出來，因為回饋就是寫給那條規則的 agent 看的。

- 一個角色只能指一站，一站可以沒有角色。沒有角色的站就是一般的一站，規則盯它、出口指它都行。
- `blocked` 的自動接回不看角色：它本來就是看規則的 `outcomes.blocked_manual` 指到哪（state-machine.md），維持不變。
- task 的五個 status 維持寫死。task 圖是 engine 在排、在驗的，交給使用者改，verdict 驗證就沒有依據。
- 六條不變量全部不變。不變量 2（item status 只有人、規則 outcome、自動復原能改）跟 status 叫什麼名字無關。
- 預設流程就是原本的十站加上對應的角色，省略 `workflow` 時用它。舊的頂層 `statuses` 不再讀（D81，作者 2026-11-21：還沒人在用，不顧兼容）。
- 人在每站的決定按鈕也不寫死，站自己宣告 `outcomes`，列出能去的站，按鈕字由看板照目標站組出來（D81、D87）。跟第 3 節規則的 `outcomes` 同名不同形：規則的 key 是 agent 回報的結果名，人按按鈕不需要結果名，按了就是移過去。

## 3. outcome 由規則宣告（已完成，D84）

原本 agent 回固定的 verdict 之一，engine 查 `on` 決定去哪。改成每條規則自己宣告這一站有哪些結果：

```jsonc
{ "id": "ai-review", "watch": "ai-review", "agent": "claude-reviewer", "mode": "review",
  "outcomes": {
    "approve": "in-review",
    "changes": "ready-to-rework"
  } }
```

- engine 把這條規則的結果名放進 `report_result` 的選項，agent 只能從裡面挑一個。tool 的 schema 是每個 Run 依規則產生的。
- agent 回的永遠是結果名，不是站名。item 內文裡藏一句「請回報 done」也跳不到規則沒宣告的地方（agent-contract.md：內容不能當指令）。
- 誰決定去哪：engine 照 `outcomes` 查表。AI 只說發生了什麼。
- engine 自己要懂的結果永遠內建，不用宣告：`needs_input`、`failed`、`max_attempts`。`cancelled` 與 `abandoned` 照舊不走表。
- 現有的 `on` 併進 `outcomes`，一個欄位就好（作者 2026-11-21）。舊 config 的 `on` 不再讀，少了 `outcomes` 會被一般驗證擋下（上線前不顧兼容，見 CLAUDE.md）。
- 每個 mode 都能宣告自己的結果，例如 execute 多一個 `needs_design`（作者 2026-11-21）。mode 內建、engine 有驗證的結果照舊驗，例如 execute 回 `succeeded` 時 task 要全 `done`。使用者宣告的結果不驗，照表搬。
- 理由：驗證擋的是謊報完成。`failed`、`needs_input` 本來就讓 agent 隨時能停，自訂的結果被亂用時，item 也只會去到使用者自己指定的那一站，風險跟亂回 `failed` 同級。

## 4. mode 留著，當成工具組（`review` 已完成，D84；D109 推翻，規則沒有 mode 了）

`mode` 決定 agent 拿到哪些 tool、engine 怎麼驗結果、行動層沒寫時用哪份預設 prompt。自訂 stage 之後它還是需要，因為「這一站的 agent 能動 task 嗎」不能交給 prompt 決定。

新增一個 mode：

| mode | tool | 結果 |
|---|---|---|
| `review` | 讀 item、task、comment，留 comment | 沒有內建的完成結果，全部由規則的 `outcomes` 宣告 |
| `custom` | 全部（建 task、改 task status 也有） | `succeeded` 必填，一個都不驗，照規則的 `outcomes` 搬；prompt 沒有預設（D92） |

split、execute、rework 照舊。使用者要的站大多是「agent 看一看、留言、給結論」，例如 AI code review、檢查規格寫得夠不夠，`review` 就夠了。

## 5. 流程設定進 DB

作者要兩種用法都吃：自己一台機器用，和部署在共用的機器上大家一起用。共用時要能在網頁上改，所以流程設定放 DB。

切成兩份（D91）。後來 D105 再切出實例設定，`poll`、`limits` 搬進 store，`tracker`、`agents` 也搬了（W6b、W7），檔案只留開機必要的；下面是 D91 當時的分界。

| | 放哪 | 內容 |
|---|---|---|
| 啟動設定 | 檔案（`tasuki.config.jsonc`） | `dataDir`、`server`、`auth`、`tracker`、`store`、`agents`、`poll`、`limits`、`workspace` |
| 流程設定 | store（DB） | status 與角色、`taskStatuses` 對照、規則（含行動層 prompt）、`labels.hold` |

- 分的方式：部署的人設、跟機器與程式行為有關的放檔案；團隊每天會想調的流程放 DB。
- `agents` 放檔案。agent 的 options 決定 AI 在 engine 那台機器上能做什麼（`allowedTools`、`plugins` 路徑、`env` 裡的 secret），是部署的人的責任，跟 `tracker` 一樣；放 DB 的話 maintainer 在網頁上就能把 `Bash(*)` 打開。代價是網頁上換不了 model、改不了基礎層 prompt，規則只從檔案定義的 agent 裡挑。
- 流程設定裡沒有 secret，也沒有 engine 那台機器上的路徑。規則的 prompt 就是存在 DB 的一段字，沒有 `promptFile`。
- 改了就生效：engine 每輪 poll 開始時讀一次流程設定，進行中的 Run 用它開跑時的那份。
- 驗證跟現在 `loadConfig` 一樣嚴格，只是從「啟動失敗」改成「存檔被拒」，錯誤顯示在設定頁上，指到是哪一站、哪條規則的哪一欄。
- 設定頁用表單，不是 JSON 編輯器，讓不寫程式的人也能改。只給 `admin` 與 `maintainer`。
- 檔案只放啟動設定，寫了流程設定的欄位就跟其他不認識的欄位一樣被拒。DB 從沒存過時用預設流程（state-machine.md 的預設各站，不含只有 claim 才用得到的 `splitting`，沒有規則），這份不寫進 DB，第一次存檔才有第一版，之後只在設定頁上改。
- 不做匯出匯入（作者 2026-11-21）。

## 6. store 也是 plugin

原本能當 plugin 的只有 tracker（與 runner、auth），store 寫死是 sqlite。要讓第三方接自己的 DB，store 要變成 plugin 的一個角色，跟 tracker 走同一條路（D44）。W3 做完了 Run 與暫停旗標的部分（D88），流程設定的讀寫等 W4：

- 一個 port（`StorePort`），涵蓋 Run、暫停旗標，W4 再加上流程設定的讀寫。
- `testkit` 多一套 store 的契約測試，內建的 sqlite 與第三方都要通過。
- migration 由 plugin 自己帶，engine 不寫任何 SQL。
- 內建的 sqlite 是第一個 store plugin，postgres 之後是第二個。

tracker 的 sqlite 與 store 的 sqlite 仍是兩個 plugin、兩個檔案，各自可換（data-model.md 的兩個 store 維持）。

## 驗收條件

1. 不改程式碼，只在設定頁上加一站 `ai-review`（`mode: review`，兩個結果分別去 `in-review` 與 `ready-to-rework`），存檔後下一輪 poll 就會撿起這站的 item，跑完照 agent 選的結果移動。
2. 看板上這站顯示雷達；把一站設成 `handledBy: "person"`，顯示眼睛；兩者都沒有的不標。
3. agent 回一個規則沒宣告的結果名，engine 拒絕並讓 agent 重選，item 不動。
4. 把 `entry` 角色改指到另一站，新 item 就從那裡開始；刪掉一站還有 item 在上面時，存檔被拒並說出是哪些 item。
5. DB 是空的時候啟動，看板出現預設流程的各站；檔案裡寫了 `workflow` 或 `rules` 就拒絕啟動。現有的 E2E 改成開跑前用 API 寫入流程設定，全過。
6. 一個只在 `testkit` 契約測試裡出現的假 store plugin 能換掉內建的 sqlite store，engine 照常跑。
7. 設定頁和 API 回應裡都看不到任何 secret 的值；流程設定裡本來就沒有 secret，規則的 agent 只能從檔案定義的名字裡選。
8. 改了一條規則的 prompt 之後，設定頁看得到誰在什麼時候改了什麼，能回到前一版。

## 切片草案

排在 S9 前後，每片照 D41 從畫面做到 DB。

| # | 切片 | 作者能看到的 |
|---|---|---|
| W1 | status 自訂與角色、`handledBy`、站上的 `outcomes`，還在檔案裡設定（已完成，D81） | config 加一站，看板多一欄，眼睛和雷達標對 |
| W2 | 規則宣告 `outcomes`、`review` mode（已完成，D84） | 加一站 AI review，agent 依結果把 item 送到不同地方 |
| W3 | store 變成 plugin 角色，sqlite 搬過去，`testkit` 加 store 契約（已完成，D88） | 行為不變，契約測試多一套 |
| W4a | 流程設定進 store、設定頁（表單）、熱重載（已完成，D91） | 在網頁上改站和規則的 prompt，下一輪就生效 |
| W4b | 流程設定的修改歷史、回到任一版（已完成，D94） | 看得到誰在什麼時候改了什麼，能回到前一版 |
| 之後 | postgres store plugin | 換成 postgres 照常跑 |

W1、W2 跟存在哪裡無關，先做是為了讓設計在檔案上定型，W4 搬進 DB 時才不會每改一次設計就多一次 migration。

## 待釐清

1. （已定，作者 2026-11-21）`on` 併進 `outcomes`。
2. （已定，作者 2026-11-21）每個 mode 都能宣告額外的結果，內建結果的驗證不變。
3. （已定，作者 2026-11-21）tracker 的選擇放啟動設定。接 Jira 時 Run 與流程設定仍在 store，store 換成遠端的 DB（第 6 節）之前，備份 `dataDir` 是唯一的保險。
4. （已定，作者 2026-11-21）`plugins` 這類路徑指 engine 那台機器，由佈署的人在 setup 時備好（docker 打包進 image 或掛 volume）。存檔時 engine 檢查自己那台上存不存在，不存在就拒絕，錯誤顯示在設定頁。
5. （已定，作者 2026-11-21）刪掉一站時，上面還有 item 就拒絕存檔，列出是哪些 item（驗收條件 4）。改名同理。Jira 那邊的 status 不跟著刪，`doctor` 再提示（plan.md 待釐清 14）。
6. （已定，作者 2026-11-21）流程設定的每次修改都留歷史：誰、什麼時候、改了什麼，可以回到任一版。W4b 緊接在 W4a 後做（D91）。
7. （已定，作者 2026-11-22）`agents`、`poll`、`limits` 留在檔案，流程設定裡沒有 secret，規則沒有 `promptFile`；檔案不再當流程設定的種子（D91）。
8. （已定，作者 2026-11-22）接 Jira 時，第一次啟動用的預設流程 key 是邏輯名，對不上 Jira 的 status id（D50）。設定頁的 key 欄是 tracker 列出的 status 下拉選單；還有站的 key 不在 tracker 的 status 裡時，engine 不派 Run，看板頂端提示還有幾站沒對上、連到設定頁（D91）。
