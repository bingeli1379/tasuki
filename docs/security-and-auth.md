# Security and auth

狀態：已確認。loopback 檢查作者曾問過是否過嚴，見該節。身分與權限一節依 D89 改寫，port 簽名是草稿。

## 威脅模型

這個 engine 的 API 能把 item 拉進觸發 status、能改 item 的內容，而那些內容會被交給掛著工具的 agent 去執行。所以：

- API 被未授權的人碰到，等於遠端驅動一個有工具權限的 agent，不只是看板被偷看。
- ticket 內容是 prompt injection 的入口。一張惡意的 item 可能夾帶指令。
- agent 的環境裡有 git token、MCP 之類的憑證。

## Server 綁定

- `server.host` 預設 `127.0.0.1`。
- 啟動檢查：`host` 不是 loopback、沒設 `auth`、而且沒設 `server.allowInsecure: true`，就拒絕啟動並說明原因。
- 這只是一個啟動檢查，成本很低，理由是上面的威脅模型。作者問過是否太嚴。若要放寬，退一步是改成啟動時大聲警告，仍建議保留拒絕啟動。
- Docker：容器內本來就要綁 `0.0.0.0`，所以 compose 範例要明寫 `allowInsecure` 或設 auth，並且 host 端的 port 只開在 `127.0.0.1`。
- engine 自己不做 TLS。綁在非 loopback 的部署一律放在負責 HTTPS 的 reverse proxy 或 ingress 後面，engine 只聽 proxy 轉進來的 HTTP。理由：公司環境本來就有一層 proxy，憑證在那裡管理與更新；engine 自己做 TLS 只會多一份要輪替的憑證（D60）。
- `server.publicUrl`：使用者從瀏覽器打開的網址，例如 `https://tasuki.example.com`。`host` 不是 loopback 時必填，而且必須是 `https`，否則拒絕啟動。`Host` header 與 `Origin` 的檢查都拿它來比對。

## 身分與權限

「你是誰」與「你能做什麼」分開管（D89）：

- 身分交給 auth plugin。它只回答這組帳密是不是某個人，回傳 `userId` 與 `displayName`。
- 權限一律放在 tasuki 的 store，用 `userId` 對到一個 access。不管帳號是 tasuki 自己管還是外部管，指派都在看板上做。

```ts
// draft; the code is the source once it exists
interface AuthPort {
  login(credentials: { username: string; password: string }): Promise<Identity | undefined>
}
```

auth 是 plugin 的一個角色，config 寫法跟其他角色一樣（`plugin` 加 `options`）。省略 `auth` 就是不登入。

| plugin | 帳號在哪 | 行為 |
|---|---|---|
| 省略 | 沒有帳號 | 不登入，本機用。每個請求都當成 `admin`，看板不顯示管理帳號的頁面。 |
| `@tasuki/auth-builtin` | tasuki 的 store | tasuki 自己管帳號：`admin` 在看板上建帳號、重設密碼。不提供預設帳號或預設密碼。帳號沒有另外的顯示名，大家看到的就是帳號名。 |
| `@tasuki/auth-http` | 外部系統 | 登入頁收到的帳密轉給使用者提供的 API。契約草稿：`POST <url>` 帶 `{ username, password }`，成功回 `200 { userId, displayName }`，失敗回 4xx。 |

`auth-http` 不是 SSO：使用者每次都在 tasuki 的登入頁打帳密，密碼會經過 tasuki，所以非 loopback 時一定要在 HTTPS proxy 後面，engine 也不把它寫進 log。公司只開 OIDC 或 SAML 時，另做一個 `auth-oidc` 之類的 plugin，權限那一半不用動。

### access

| access | 能做的事 |
|---|---|
| `admin` | 下面全部，加上管帳號：建帳號、重設密碼（builtin）、改別人的 access、停用帳號。 |
| `maintainer` | 下面全部，加上改流程設定（stage、規則、prompt）。 |
| `member` | 用看板與 `/mcp` 做所有操作：建 item、移動、留言、Stop、hold、刪 item。 |

- 流程設定目前還在 config 檔裡，網頁上沒有設定頁，所以 W4 之前 `maintainer` 與 `member` 實際上一樣。設定頁只給 `admin` 與 `maintainer` 這條跟 W4 一起做。
- 外部帳號第一次登入成功時，store 建一筆帳號，access 是 `member`。之後由 `admin` 升級。
- 停用的帳號不能登入，它的 session 與個人 API token 立刻失效。外部帳號只能停用不能刪，刪了下次登入又會建回來。
- 最後一個 `admin` 不能被降級或停用，不然就沒有人能管帳號了。
- 身分用來記錄操作者：人寫的 comment 與按鈕留的 `system` 紀錄帶登入者的顯示名（`authorName`）。Jira 上 tasuki 寫的 comment 都顯示 engine 的帳號，所以名字放在 comment property `tasuki` 的 `name`，看板讀它；Jira 網頁照樣顯示 engine 的帳號。
- 管帳號（建帳號、重設密碼、改 access、停用）與個人 API token 只在看板上做，不進使用者 MCP，是 D57 的例外：重設密碼走 MCP，密碼就會留在 AI 的對話紀錄裡。

### 第一個 admin

builtin 與 http 用同一招：

1. engine 啟動時發現 store 裡沒有任何啟用中的 `admin`，就產生一次性的 setup token，印在啟動 log，也寫進 `<dataDir>/setup-token`（權限 600）。跟 Jenkins 的 initialAdminPassword 一樣，container 的主人看 log 或讀檔都拿得到。
2. builtin：在登入頁貼 setup token，建第一個帳號，它就是 `admin`。http：先用外部帳號登入，再貼 setup token 把自己升成 `admin`。
3. 有 `admin` 之後 token 立刻作廢，檔案也刪掉。engine 重啟時如果還是沒有 `admin`，就再產生一個新的；已經有 `admin` 時啟動會把殘留的檔案刪掉。

不讓「第一個打開網頁的人自動變 admin」，因為綁在非 loopback 時誰先搶到就是誰的。不做 CLI 指令，因為 container 裡看 log 比 exec 進去容易。

### session

登入成功後 engine 發自己的 session token。

- 看板用 cookie 帶 session：`HttpOnly`（前端 JavaScript 讀不到，XSS 偷不走）、`Secure`、`SameSite=Lax`。`Secure` 只在 `publicUrl` 是 https 時加，因為有些瀏覽器在 `http://localhost` 不收 `Secure` cookie，只綁 loopback 時就登不進去（D89）。`Lax` 而不是 `Strict`，是為了從 Slack 或信件點連結進看板時還是登入狀態。
- session 存在 store，cookie 裡只放隨機值，DB 只存它的 hash。登出或過期就刪掉，server 端立刻失效，不靠 cookie 自己過期。
- CSRF：會改東西的請求（`POST`、`PUT`、`PATCH`、`DELETE`）帶了 `Origin` 時，它必須是 loopback 或 `server.publicUrl` 的 origin，對不上回 403。沒帶 `Origin` 的是瀏覽器以外的 client，不是 CSRF 的對象。不登入時也檢查，因為惡意網頁一樣能讓瀏覽器對 `127.0.0.1` 發 `POST`。`SameSite=Lax` 已經擋掉大部分跨站請求，`Origin` 檢查補上同站子網域與舊瀏覽器的缺口。
- 有效期由 `auth.session.ttl` 設定，吃時間長度（`"7d"`）或 `"never"`。預設 7 天。
- 改了 ttl，之前發的 session 全部失效：session 記著發出時的 ttl，驗證時跟現在的設定不同就刪掉、回 401。不只在啟動時清，因為 W4 之後 ttl 會在執行中被改。
- `never` 允許，但不建議：有登入的情況下 token 洩漏等於永久通行證。
- 測試過期機制不實際等待，時間從可注入的 `Clock` 取，測試裡直接撥快。
- 除了 `/api/health`（只回 `{ ok: true }`）、登入與 setup token 本身，所有 REST 與 `/mcp` 都要通過驗證。新加的 route 預設要驗證，例外要明寫，不是反過來。

### builtin 的密碼

- store 只存密碼的 hash。演算法用 Node 內建的 scrypt，不另外裝套件。
- 密碼由 `admin` 在看板上設定或重設，帳號本人登入後可以改自己的（要先輸入目前的密碼）。設新密碼時要輸入兩次。
- 規則只看長度，至少 8 個字元，不要求大小寫、數字、符號的組合。NIST SP 800-63B 第 4 版反對組合規則；它對「只有密碼一道關」要求至少 15 個字元，作者選擇維持 8（D89）。
- 帳號不存在時也跑一次 scrypt，讓回應時間不透露哪些帳號存在。

### 防暴力破解

- 登入失敗以帳號計數。同一個帳號連續失敗 5 次以內不延遲，從第 6 次起，下一次登入的回應延遲 1 秒、2 秒、4 秒，一路加倍到 30 秒為止，成功就歸零。
- 不鎖帳號：鎖帳號讓任何人都能故意把別人鎖在外面。
- 以帳號而不是 IP 計數，不用信任 proxy 帶的 `X-Forwarded-For`。計數放記憶體，engine 只有一個 instance，重啟歸零可以接受。
- `auth-http` 也套用同一套，不假設使用者提供的驗證 API 自己有擋。setup token 也算，以固定的 key 計數。
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

Claude Code 與 Codex 不會填登入表單，也不適合放一個幾天就過期的 session，所以 `/mcp` 用個人 API token（D60）：

- 登入後在看板上產生，可以取名字（例如「筆電上的 Claude Code」），產生時只顯示一次。
- DB 只存 hash。每張 token 綁產生它的使用者，權限跟著那個人的 access 走，看板上列得出來、可以一張一張撤銷，撤銷立刻生效。
- 可以設到期日，預設不過期；token 只能用在 `/mcp`，撤銷是主要的防線。
- `/mcp` 只收 `Authorization: Bearer <token>`，不吃看板的 cookie。惡意網頁就算讓瀏覽器對 `/mcp` 發請求，也帶不到使用者的身分。
- 沒設 `auth` 時不需要 token，跟看板一樣。

已知風險：只綁 loopback 擋不住 DNS rebinding，惡意網頁可以讓瀏覽器把請求送到 `127.0.0.1:8787`。REST 與 `/mcp` 都受影響，所以每個請求都檢查 `Host` header：只接受 loopback 的名稱（`localhost`、`127.0.0.1`、`[::1]`），以及 `server.publicUrl` 的 host（S9c），對不上回 403。不登入時也檢查。

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
- 反過來，engine 自己的環境不傳給 agent。`.env` 會載入 engine 的 process，裡面有 tracker 的 token，所以 runner 只放行找得到 CLI、登入與 shell 需要的幾個變數，其他要給 agent 的寫進 `options.env`（D76）。
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
