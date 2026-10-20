# Tasuki

設計階段的文件，目前沒有程式碼。寫給作者自己在實作時查閱。
內文用繁體中文，識別字、status key、config key 一律英文。

## 閱讀順序

| # | 檔案 | 定下什麼 | 狀態 |
|---|---|---|---|
| 1 | glossary.md | 全部文件共用的名詞 | 已確認 |
| 2 | architecture.md | 元件、port、一次執行的流程、部署形態、暫定技術棧 | 已確認，技術棧暫定 |
| 3 | data-model.md | 實體、兩個 store、sqlite / Jira 對照 | 已確認 |
| 4 | state-machine.md | item 與 task 的狀態機、規則 outcome、不變量 | 已確認 |
| 5 | config-and-rules.md | config 形狀、預設規則、驗證規則 | 草稿 |
| 6 | agent-contract.md | MCP tool、verdict、engine 怎麼驗證一次 Run | 草稿 |
| 7 | stop-and-recovery.md | 停止、lease、當機復原、迴圈控制 | 概念已確認，數字是草稿 |
| 8 | workspace-and-git.md | 每張 item 的工作目錄、預設 branch 慣例 | 已確認 |
| 9 | plugins.md | plugin 的形狀、三個角色、契約與載入方式 | 草稿，只有方向確認 |
| 10 | security-and-auth.md | auth port、loopback 檢查、run token、secret | 已確認，loopback 檢查作者曾質疑 |
| 11 | decisions.md | 決定紀錄與理由 | 持續更新 |
| 12 | plan.md | 範圍、切片、測試、風險、待釐清、待驗證 | 草稿 |

## 慣例

- 圖一律用 mermaid 寫在 markdown 裡，AI 讀得懂，git 也能 diff。
- 名詞以 glossary.md 為準。
- 程式碼出現之後，config 的 JSON Schema 和 TS 型別是唯一來源，文件和它衝突時以程式碼為準。
- 標「草稿」的文件，欄位與數字都還沒逐項確認。標「待驗證」的事實是憑印象寫的，動手前要對現行文件確認，清單在 plan.md。
