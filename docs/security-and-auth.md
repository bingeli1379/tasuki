# Security and auth

狀態：已確認。loopback 檢查作者曾問過是否過嚴，見該節。

## 威脅模型

這個 engine 的 API 能把 item 拉進觸發 status、能改 item 的內容，而那些內容會被交給掛著工具的 agent 去執行。所以：

- API 被未授權的人碰到，等於遠端驅動一個有工具權限的 agent，不只是看板被偷看。
- ticket 內容是 prompt injection 的入口。一張惡意的 item 可能夾帶指令。
- agent 的環境裡有 git token、MCP 之類的憑證。

## Server 綁定

- `server.host` 預設 `127.0.0.1`。
- 啟動檢查：`host` 不是 loopback、`auth.kind` 是 `none`、而且沒設 `server.allowInsecure: true`，就拒絕啟動並說明原因。
- 這只是一個啟動檢查，成本很低，理由是上面的威脅模型。作者問過是否太嚴。若要放寬，退一步是改成啟動時大聲警告，仍建議保留拒絕啟動。
- Docker：容器內本來就要綁 `0.0.0.0`，所以 compose 範例要明寫 `allowInsecure` 或設 auth，並且 host 端的 port 只開在 `127.0.0.1`。

## Auth port

```ts
interface AuthPort {
  login(credentials: unknown): Promise<Identity>
  verify(sessionToken: string): Promise<Identity | undefined>
}
```

| kind | 行為 |
|---|---|
| `none` | 不登入。local 預設。 |
| `static` | 設定檔裡寫帳號與密碼。不提供預設密碼，要用就必須自己設。 |
| `http` | 呼叫使用者提供的驗證 API。契約草稿：`POST <url>` 帶 credentials，成功回 `200 { userId, displayName }`，失敗回 4xx。 |

登入成功後 engine 發自己的 session token。

- 有效期由 `auth.session.ttl` 設定，吃時間長度（`"24h"`）或 `"never"`。預設 24 小時。
- `never` 允許，但不建議：有登入的情況下 token 洩漏等於永久通行證。
- 測試過期機制不實際等待，時間從可注入的 `Clock` 取，測試裡直接撥快。
- 目前的授權：登入成功就有完整權限。身分只用來記錄操作者（`cancelRequestedBy`、`system` comment）。角色與權限之後再說。

## Run token（agent 用的 MCP token）

- 每個 Run 發一個，跟人登入的 token 是兩套，互不相干。
- 綁定該 item 與它底下的 task，能用的 tool 由 rule 的 `mode` 決定（見 agent-contract.md）。
- Run 結束、取消、`abandoned` 時立刻失效。
- agent 拿不到 tracker 的 token。Jira 的 token 只存在 engine 裡。

## Plugin 的信任範圍

- plugin 是 in-process 的 npm 套件，與 engine 同一個 process、同樣的權限。它是受信任的程式碼，信任程度等同 `package.json` 裡的其他相依。
- 所以 plugin 能讀到 process 的環境變數與檔案系統。只裝信任的來源，沒有沙箱可以擋。
- `doctor` 與啟動 log 要列出載入了哪些 plugin 與版本，讓人看得出實際跑的是什麼。

## Secret 處理

- config 不放明文，使用 `${ENV_VAR}`。
- `agents.<name>.env` 只傳給被 spawn 的那個 CLI，engine 自己不用。
- engine 不把 secret 寫進 log、`system` comment 或 API 回應。

## Agent 的權限

- 每個 agent 設 `allowedTools` 白名單。headless 執行需要預先授權，沒有人可以現場按同意。
- 不建議用跳過所有權限檢查的模式，除非整個 runner 在沙箱或容器裡。
- 雲端部署的 runner 放在容器裡。
- 人工把關有兩處：`split-review`（檢查 AI 開的 task）與 `in-review`（檢查成果）。

## Claude 的認證方式

| `auth` | 說明 |
|---|---|
| `inherit-login` | 沿用本機 CLI 已登入的帳號。local 模式用。 |
| `api-key` | 用 API key。雲端部署的預設。 |
| `oauth-token` | 用訂閱的 OAuth token。 |

三種都會支援，選哪種是使用者的事，README 要把風險寫清楚。
官方的 legal and compliance 頁寫的是：OAuth 登入是給一般使用 Claude Code 這類原生應用，做產品或服務（包含 Agent SDK）應該用 API key。雲端、多人共用的 engine 落在「服務」那邊。有第三方文章說條款在 2026 年 2 月更新過，發版前要對原文。Codex 的條款沒查過。`claude setup-token` 這類繞法不寫進官方文件。

## Jira 的身分

engine 用的 token 是誰，寫入的東西就顯示成誰。用專用 bot 帳號或個人 token 都可以。comment 一律帶標記（見 data-model.md），所以兩種情況都分得出來是人還是 engine。
