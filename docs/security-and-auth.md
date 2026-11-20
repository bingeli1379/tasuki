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
- engine 自己不做 TLS。綁在非 loopback 的部署一律放在負責 HTTPS 的 reverse proxy 或 ingress 後面，engine 只聽 proxy 轉進來的 HTTP。理由：公司環境本來就有一層 proxy，憑證在那裡管理與更新；engine 自己做 TLS 只會多一份要輪替的憑證（D60）。
- `server.publicUrl`：使用者從瀏覽器打開的網址，例如 `https://tasuki.example.com`。`host` 不是 loopback 時必填，而且必須是 `https`，否則拒絕啟動。`Host` header 與 `Origin` 的檢查都拿它來比對。

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

- 看板用 cookie 帶 session：`HttpOnly`（前端 JavaScript 讀不到，XSS 偷不走）、`Secure`、`SameSite=Lax`。`Lax` 而不是 `Strict`，是為了從 Slack 或信件點連結進看板時還是登入狀態。
- session 存在 runtime store，cookie 裡只放隨機值，DB 只存它的 hash。登出或過期就刪掉，server 端立刻失效，不靠 cookie 自己過期。
- CSRF：會改東西的請求（`POST`、`PUT`、`PATCH`、`DELETE`）檢查 `Origin` 必須等於 `server.publicUrl` 的 origin，對不上回 403。`SameSite=Lax` 已經擋掉大部分跨站請求，`Origin` 檢查補上同站子網域與舊瀏覽器的缺口。
- 有效期由 `auth.session.ttl` 設定，吃時間長度（`"24h"`）或 `"never"`。預設 24 小時。
- `never` 允許，但不建議：有登入的情況下 token 洩漏等於永久通行證。
- 測試過期機制不實際等待，時間從可注入的 `Clock` 取，測試裡直接撥快。
- 授權：登入成功就有完整權限，不分角色（D60）。身分只用來記錄操作者（`cancelRequestedBy`、`system` comment）。
- 除了 `/api/health`（只回報活著與 schema 版本）與登入本身，所有 REST 與 `/mcp` 都要通過驗證。新加的 route 預設要驗證，例外要明寫，不是反過來。

### `static` 的密碼

- config 只放密碼的 hash，不放明文。演算法用 Node 內建的 scrypt，不另外裝套件。CLI 提供產生 hash 的指令。
- 啟動時發現值不是 hash 的格式就拒絕啟動，因為那多半是有人直接把密碼貼進去了。

### 防暴力破解

- 登入失敗以帳號計數。同一個帳號連續失敗，下一次登入的回應延遲 1 秒、2 秒、4 秒，一路加倍到 30 秒為止，成功就歸零。
- 不鎖帳號：鎖帳號讓任何人都能故意把別人鎖在外面。
- 以帳號而不是 IP 計數，不用信任 proxy 帶的 `X-Forwarded-For`。計數放記憶體，engine 只有一個 instance，重啟歸零可以接受。
- `http` 也套用同一套，不假設使用者提供的驗證 API 自己有擋。
- 錯誤訊息不分「帳號不存在」與「密碼錯」。

## Run token（agent 用的 MCP token）

- 每個 Run 發一個，跟人登入的 token 是兩套，互不相干。
- 綁定該 item 與它底下的 task，能用的 tool 由 rule 的 `mode` 決定（見 agent-contract.md）。
- Run 結束、取消、`abandoned` 時立刻失效。
- 只放在 engine 的記憶體，不落地。engine 重啟時所有 Run 本來就會變成 `abandoned`，token 不需要活過重啟（D63）。
- agent 帶著它打 `/agent-mcp`（`Authorization: Bearer <token>`），對不到存活的 Run 一律 401。
- agent 拿不到 tracker 的 token。Jira 的 token 只存在 engine 裡。

## 使用者 MCP

`/mcp` 的身分是使用者，能做的事跟看板一樣，包含改 item status，所以它跟 REST API 是同一個威脅面，套同樣的綁定與 auth（D57）。S9 之前只綁 `127.0.0.1`，沒有登入。

Claude Code 與 Codex 不會填登入表單，也不適合放一個 24 小時就過期的 session，所以 `/mcp` 用個人 API token（D60）：

- 登入後在看板上產生，可以取名字（例如「筆電上的 Claude Code」），產生時只顯示一次。
- DB 只存 hash。每張 token 綁產生它的使用者，看板上列得出來、可以一張一張撤銷，撤銷立刻生效。
- 可以設到期日，預設不過期；token 只能用在 `/mcp`，撤銷是主要的防線。
- `/mcp` 只收 `Authorization: Bearer <token>`，不吃看板的 cookie。惡意網頁就算讓瀏覽器對 `/mcp` 發請求，也帶不到使用者的身分。
- `auth.kind` 是 `none` 時不需要 token，跟看板一樣。

已知風險：只綁 loopback 擋不住 DNS rebinding，惡意網頁可以讓瀏覽器把請求送到 `127.0.0.1:8787`。REST 與 `/mcp` 都受影響，S9 一起檢查 `Host` header：只接受 loopback 的名稱，以及 `server.publicUrl` 的 host。

## 附件與內容

附件與 ticket 內容都是任何人都能寫進來的東西，看板當成不可信內容處理（D61）：

- 附件最大 10 MB，server 在讀完 body 之前就擋。
- 只有 png、jpeg、gif、webp 在瀏覽器裡直接顯示；其他一律 `application/octet-stream` 加 `Content-Disposition: attachment` 強制下載。SVG 也算其他，因為它可以帶 script。
- 每個附件回應都帶 `X-Content-Type-Options: nosniff` 與 `Content-Security-Policy: default-src 'none'; sandbox`。
- 讀附件時檢查它屬於網址上那張 item，不能拿 A 的網址讀 B 的附件；Jira 模式下 tasuki 也只讀自己 project 的 item。
- markdown 用 markdown-it 畫，關掉 HTML，`javascript:` 這類連結它本來就不產生。連結開新分頁並帶 `rel="noopener noreferrer"`。

## Plugin 的信任範圍

- plugin 是 in-process 的 npm 套件，與 engine 同一個 process、同樣的權限。它是受信任的程式碼，信任程度等同 `package.json` 裡的其他相依。
- 所以 plugin 能讀到 process 的環境變數與檔案系統。只裝信任的來源，沒有沙箱可以擋。
- `doctor` 與啟動 log 要列出載入了哪些 plugin 與版本，讓人看得出實際跑的是什麼。

## Secret 處理

- config 不放明文，使用 `${ENV_VAR}`。本機開發可以放在 config 旁邊的 `.env`，它不進 git（D49）。
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
