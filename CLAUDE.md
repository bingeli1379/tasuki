# Tasuki

後端 engine 定時檢查 tracker（sqlite 或 Jira Cloud），命中規則就派 agent（claude / codex CLI）做事，結果寫回。規則、status 對照、agent 都在一份 config 裡。目前設計文件描述整個產品，不分版本。程式碼只有骨架：`core`（空）、`sqlite`（tracker plugin 的地基，目前只有開 DB 與 migration）、`server`（Hono，含 runtime store）、`web`（Vue 3 SPA）。功能依 `docs/plan.md` 的切片清單，一次一個從畫面做到 DB。

## 開發之前

先讀文件，理解架構，再動手。從 `docs/README.md` 開始，那裡有閱讀順序與每份文件的狀態。

依任務挑要讀的：

| 任務 | 必讀 |
|---|---|
| 任何任務 | `docs/glossary.md`、`docs/architecture.md` |
| 改 domain、狀態轉移、規則比對 | `docs/state-machine.md`、`docs/data-model.md` |
| 改 storage adapter、DDL | `docs/data-model.md`、`docs/architecture.md`（Ports） |
| 改 config、規則、`doctor` | `docs/config-and-rules.md` |
| 改 MCP tool、verdict 驗證、prompt | `docs/agent-contract.md` |
| 改停止、lease、復原 | `docs/stop-and-recovery.md` |
| 改 workspace 或 git 相關 | `docs/workspace-and-git.md` |
| 改 auth、token、secret、server 綁定 | `docs/security-and-auth.md` |
| 要做取捨 | `docs/decisions.md`（先看有沒有已經定過） |
| 排工作順序 | `docs/plan.md` |

文件沒講到的行為，不要自己編。先指出文件缺什麼，問過之後再補進文件。
標「草稿」的文件欄位還沒確認，標「待驗證」的事實是憑印象寫的，兩者都要先跟作者確認或對現行文件查證，不能當成定案。

## 怎麼開發

- 文件描述整體設計，不分版本（D45）。實作順序只看 `plan.md` 的切片。
- 一次做一個功能（切片），從畫面一路做到 DB，做完能在瀏覽器操作再做下一個，不先寫完整層（D41）。
- 切片開始前先講清楚這個功能的場景（誰做什麼、畫面看到什麼、資料怎麼變），再往下實作。
- core 只長出該切片需要的型別與規則。DB 的表在用到的切片才寫成 migration。
- 本機跑：`pnpm build`，然後 `node packages/server/dist/index.mjs`（8787，DB 在 `./data/runtime.db`，目錄可用環境變數 `TASUKI_DATA_DIR` 改）與在 `packages/web` 跑 `pnpm exec vp dev`（5173，要用 `localhost`）。

## 開發之後

有改動就回去更新文件，和程式碼放在同一個 change 裡。

| 改了什麼 | 更新哪份 |
|---|---|
| status、轉移、outcome、不變量 | `state-machine.md`，必要時連同 `config-and-rules.md` 的預設規則 |
| 實體、欄位、DDL | `data-model.md` |
| 元件、port、部署形態、技術棧 | `architecture.md` |
| config 欄位、預設值、驗證規則 | `config-and-rules.md` |
| MCP tool、verdict、Run 的輸入輸出 | `agent-contract.md` |
| 停止、lease、復原、迴圈控制 | `stop-and-recovery.md` |
| workspace、branch 慣例 | `workspace-and-git.md` |
| auth、token、secret | `security-and-auth.md` |
| 新增、推翻、修改一個決定 | `decisions.md`（寫下決定、理由、重新檢視的條件） |
| 新名詞 | `glossary.md` |
| 里程碑進度、待釐清或待驗證項目有了結果 | `plan.md` |

規則：

- 程式碼與文件不一致時，不要默默讓它們分岔。如果是文件寫錯，改文件並在 `decisions.md` 留紀錄。如果是程式碼偏離了設計，先確認設計是否要改。
- 程式碼出現之後，config 的 JSON Schema 與 TS 型別是唯一來源。文件只描述意圖與理由，不複製欄位清單，衝突時回頭修文件。
- 狀態機的每一列轉移與六條不變量都要有對應的測試。改了其中一個，兩邊一起改。
- 驗證完「待驗證」的事實，把結果寫進文件，並從 `plan.md` 的清單移除。
- 圖一律用 mermaid 寫在 markdown 裡。
- 狀態名用邏輯名（kebab-case），顯示名才是 Title Case。

## 慣例

- 文件的內文是繁體中文，識別字、status key、config key 是英文。程式碼註解用英文。
- 所有用到現在時間的地方從 `Clock` 取，不直接呼叫 `Date.now()`。
- item 的 status 只有人、規則的 outcome、自動復原三種來源能改，agent 沒有任何改 item status 的 tool。
- 不要把 Jira 或 sqlite 的細節漏進 domain 或 MCP tool 的名稱。
- 檔案依概念命名（`work-unit.ts`、`run.ts`），不放 `types.ts`、`utils.ts` 這類依技術分類的雜物間。依賴只往內，`domain` 不 import `application`。
- 相對路徑 import 不寫副檔名（D43）。
- tracker、runner、auth 都是 plugin。內建的與第三方走同一條載入路徑，不准內建的偷用 `core` 沒公開的東西（D44）。

## 設計取向

核心理念：降低人的認知負擔，但不能因此加重開發者的負擔。兩邊要平衡。

- 人看到的 status、卡片、畫面要合理到不用思考，看名字就知道現在輪到誰、在做什麼。
- 為了這一點，背後的程式可以多做一點事，例如自動復原、自動接回、由 engine 代為轉移。
- 但不為了讓畫面好看，就讓程式繞來繞去、多出一堆特例，那是技術債。
- 取捨時兩邊都算：前台省一次思考，值不值得後台多一個狀態、一條規則、一項要維護的驗證。前台省得多、後台只多一點，就做。後台代價大、前台只省一點點，就不做。
- 兩邊的例子：改名 `ready-to-rework` 前台一眼分得出輪到誰、後台只改命名，做（D32）。新增 `reworking` 要多一個 Jira status 與驗證，前台換不到什麼，不做（D33）。
