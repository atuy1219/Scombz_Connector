# ScombZ Connector

芝浦工業大学のScombZを、本人のChatGPTから読み取るMCPサーバーです。**利用者それぞれのCloudflare WorkersとD1で動作**します。作者のChatGPTアカウント、作者のサーバー、作者のScombZセッションには依存しません。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/atuy1219/Scombz_Connector)

このプロジェクトは大学の公式サービスではありません。

## 最短のセットアップ

1. 上の **Deploy to Cloudflare** を押し、自分のGitHub・Cloudflareアカウントでデプロイします。WorkerとD1の作成、デプロイ後のD1マイグレーションに対応しています。Cloudflareの確認画面でデプロイコマンドが `npm run deploy` になっていることを確認してください。
2. 2つのSecretを設定します。デプロイ時に `ADMIN_TOKEN` と `SESSION_ENCRYPTION_KEY` の入力欄が出た場合は、後述のコマンドで生成して入力します。未設定でデプロイした場合は、Workerのトップページの「初回設定のキーを作成」で生成し、Cloudflareの **Worker → Settings → Variables and Secrets** に2つとも **Secret** として保存します。
3. Workerのトップページを開き、`ADMIN_TOKEN` で管理画面を開きます。学籍番号とパスワードでScombZへログインします。Workerは公式ScombMobile APIでBearer tokenを取得し、OTKEY経由でScombZ Webセッションを取得します。パスワードは保存しません。
4. 画面のMCP URL（`https://あなたのWorker.workers.dev/mcp`）をコピーします。ChatGPTの **Settings → Security and login → Developer mode** を有効にし、**Plugins → ＋** から登録します。認証方式は **OAuth / Dynamic Client Registration（DCR）** を選びます。Client ID・Client Secretの手入力は不要です。
5. 接続時に開くWorkerの承認ページで、`ADMIN_TOKEN` を入力して承認します。これはScombZのパスワードではありません。必要に応じて下記のSkillも追加できます。
6. 新しいチャットでScombZ Connectorを選択し、「接続できる？」や「データ構造とアルゴリズム2の第一回の資料を取得して」と依頼します。

ChatGPT側でカスタムMCPの追加・利用ができるアカウントと画面が必要です。項目が見つからない場合はWeb版を確認してください。GitHubとCloudflareだけでChatGPT側の制限を変更することはできません。

### キーをコマンドで生成する

Node.js 22以降で、リポジトリをダウンロードしたフォルダー内から実行します。

```sh
node scripts/generate-secrets.mjs
```

ランダムな64桁の16進数が2つ出ます。各利用者が異なるキーを生成してください。`ADMIN_TOKEN` は管理画面とOAuth承認で使うため、パスワードマネージャー等で保管します。`SESSION_ENCRYPTION_KEY` はセッション暗号化、OAuthクライアント情報・資料リンクの署名に使います。実際の値をGitHubやチャットに貼らないでください。

### 更新時のキーと接続の維持

通常のコード更新では、同じWorker URL・D1・キーを使い続けます。キーを毎回生成し直す必要はありません。Cloudflareの本番Workerの **Settings → Variables and Secrets** で、2つとも種類 **Secret** として保存し、Deployで反映してください。Buildの環境変数はWorker実行時のSecretとは別です。保存したSecretの値は管理画面から再表示できませんが、変数名が残っていれば値が見えないだけで消えたとは限りません。

Wranglerはデプロイ時に既存Secretを保持します。このプロジェクトでは `keep_vars: true` も指定し、管理画面で追加した通常の変数も更新時に保持します。ただし認証・暗号化キーは通常の変数ではなくSecretとして保存してください。

`SESSION_ENCRYPTION_KEY` を変更すると既存のScombZ認証、OAuthクライアント・トークン、資料リンクが無効になります。元のキーを失った場合は新しいキーを一度だけSecretとして保存し、管理画面からScombZへ再ログインしたうえでChatGPTのコネクタをDCRで作り直します。

## ScombZ認証

認証の基準はMobile APIのBearer tokenです。学籍番号とパスワードは管理画面からのログイン要求中だけ公式ScombMobile APIへ送信し、保存しません。Bearerだけを長期保持し、OTKEYは必要なときに生成して保存しません。

Web SESSIONはBearerに紐づくキャッシュとしてD1に暗号化保存し、最大6時間再利用します。期限内でもScombZ側の失効を検出したら、Bearer → OTKEY → SESSIONの経路で自動更新して再試行します。リクエストごとにOTKEYを生成しません。旧形式のSESSIONキャッシュは初回の利用時に自動更新します。

Bearerの不在・失効が確認されたときだけ再ログインを案内します。通信障害やOTKEYからのSESSION生成失敗は接続障害として表示し、Bearerを削除しません。管理画面は接続状態・再ログイン・ChatGPT接続の解除を中心に表示し、接続済みならログインフォームを折りたたみます。ChatGPT接続の解除はScombZ認証を保持し、ScombZからのログアウトはBearerとSESSIONキャッシュを削除します。

## できること

| MCPツール | 用途 |
| --- | --- |
| `get_connection_status` | ScombZセッションの確認 |
| `list_academic_terms` | 選択可能な年度・学期 |
| `list_courses` | 時間割・履修科目 |
| `list_current_tasks` | 現在のタスク・期限 |
| `list_course_contents` | 科目の教材・課題・小テスト・アンケート |
| `get_assignment` | 課題の指示・期間・提出状況・添付 |
| `get_quiz` | 受験前の要項・公開済み結果 |
| `list_surveys` / `get_survey` | アンケート一覧・設問・公開済み回答 |
| `list_announcements` | お知らせ一覧 |
| `read_file` | PDF全体を1回取得／教材・課題添付の取得 |

課題提出、受験開始、再受験、回答送信、一時保存、出席送信は提供しません。ScombZへの通信は許可した経路へのGETのみで、リダイレクトも自動追跡しません。非公開・公開期間外の資料、要項に掲載されない未受験問題は取得できません。

前期は `first`、後期は `second`。省略時は日本時間の現在期を使い、1〜3月は前年度後期として扱います。

### PDFと資料リンク

`read_file` は「PDF全体を1回取得するツール」です。引数は `course_id` と `file_id` のみで、`start_page`・`end_page`・`max_chars` は公開しません。PDF結果に `requested_pages` は含めません。同一PDFについて `read_file` を繰り返し呼ばず、初回に生成されたChatGPTファイルを再利用します。続きや特定ページはChatGPT側のFilesで、必要に応じて複数回読み取ります。

原本ダウンロードは**100MiBまで**です。5MiB以下のPDFは原本全体をMCP埋め込みリソースで返し、それを超えるPDFとその他のバイナリは**MCP `resource_link`**と10分間有効な署名付きHTTPS URLからストリーミング取得します。テキスト形式は最大8MiBまでWorker内で読み込み、本文を最大40000文字まで返します。それを超えるファイルは原本リンクのみ返します。`read_file` は原本をConnectorへ永続保存しません。

リンクは特定の科目・ファイル・Workerだけに使えます。有効期間内にリンクを知る人は原本を取得できるため、公開しないでください。リンクが期限切れでも取得済みのChatGPTファイルを再利用します。原本取得に失敗しChatGPTファイルが生成されていない場合だけ `read_file` を再実行します。管理画面の「接続を解除」はOAuthトークンを無効にしますが、すでに発行した資料リンクは最大10分残ります。「セッションを削除」すると資料リンクでの取得も停止します。

## Skill（任意）

`skills/scombz/SKILL.md` に、教材取得の順序、期限の扱い、公開済み結果の読み方をまとめています。MCP自体はSkillなしでも動作します。

Skill ZIPが必要な場合は、Python 3で以下を実行します。

```sh
python scripts/package-skill.py
```

生成した `dist/scombz-skill.zip` を対応するSkillインポート画面から追加してください。Codexでは `skills/scombz` フォルダーをユーザーのskillsディレクトリへコピーする方法も使えます。作者のPlugin IDや固定MCP URLを含む共通プラグインZIPは配布しません。各利用者が自分のMCP接続を登録します。

## データと認証

- WorkerとD1は利用者本人のCloudflareアカウントにあります。作者への転送・テレメトリーは実装していません。
- D1には認証の基準となるBearerと、最大6時間のSESSIONキャッシュをAES-256-GCMで暗号化して保存します。学籍番号・パスワード・OTKEYは保存しません。
- OAuthは `scombz:read` のみ。DCR、S256 PKCE、短期間の認証コード、1時間のアクセストークン、30日間の更新トークンのローテーションに対応します。
- OAuthトークンはハッシュで保存し、`/mcp` のresource、期限、種別を検証します。管理キーでMCPを呼び出すことはできず、OAuthトークンで管理画面を操作することもできません。
- 管理画面でOAuth接続の一括解除、ScombZからのログアウトができます。作者のChatGPTメールアドレスや `oai-authenticated-user-*` ヘッダーを認証に使いません。
- DCRのリダイレクトは `https://chatgpt.com`・`https://chat.openai.com` とHTTPのlocalhost/ループバックのみ。その他のMCPクライアントを使う場合は、`src/oauth.mjs` の許可先を利用者が確認して変更します。

## 無料枠について

Cloudflare Workers Free / D1 Freeを想定しています。Workersは1日100,000リクエストに加え、1リクエストのCPU時間10ms等の制約があります。PDF抽出ライブラリを含めず、Cookieが変わらない取得ではD1のセッションを書き直さない構成です。

無料枠内であらゆる教材・HTMLを処理できる保証はありません。大きなHTMLでCPU上限に達した場合は、Cloudflareのメトリクスで確認してください。無料枠の条件は公式ドキュメントを参照してください。

## ローカル開発・CLIデプロイ

```sh
npm ci
```

`.dev.vars.example` を `.dev.vars` にコピーし、生成した2つの値を設定します。

```sh
npm run db:local
npm run dev
```

`http://localhost:8787` で管理画面を確認できます。ローカルD1は `.wrangler` 配下です。

CLIから本番へ初回デプロイする場合:

```sh
npx wrangler login
npx wrangler secret put ADMIN_TOKEN
npx wrangler secret put SESSION_ENCRYPTION_KEY
npm run deploy
```

Secretsの設定でWorker未作成と表示された場合は、Wranglerの作成確認に従うか、先に `npx wrangler deploy` を実行してからSecretsと `npm run deploy` を設定します。WranglerはD1を自動作成し、設定へIDを反映できます。`npm run deploy` はWorkerデプロイ後に `DB` バインディングのマイグレーションを適用します。DBの作成に失敗した場合は `npx wrangler d1 create scombz-connector` で作成し、返された `database_id` を `wrangler.jsonc` に設定して再実行します。

### 検証

```sh
npm run check
```

Nodeの単体テスト、Miniflare/workerdの実際のD1・OAuth・MCP・資料取得テスト、バンドル、Wranglerのデプロイdry-runを行います。テストのScombZ応答は架空データです。実際のCloudflare本番デプロイ・ChatGPT接続・大学側との接続は利用者環境で確認してください。

## 更新方法

Deployボタンで作成した**利用者側のリポジトリ**にpushすると、Workers Buildsの接続設定に応じて再デプロイされます。作者側のpushを全利用者へ自動配信する構成ではありません。作者の更新は利用者が自分のリポジトリへ同期してください。

作者のGitHubリポジトリがなくなっても、デプロイ済みWorkerと利用者側のコピーは実行できます。作者側からの更新取得には引き続き配布元が必要です。

## 困ったとき

| 症状 | 確認する場所 |
| --- | --- |
| サーバー設定が未完了 | 2つのSecretとD1バインディング `DB` |
| 管理画面で処理が500になる | `npx wrangler d1 migrations apply DB --remote` |
| ScombZが未接続 / Mobile API認証が期限切れ | Workerの管理画面を開き、ScombZへ再ログイン |
| OAuthの `invalid_client` | 暗号化キーを変更した場合はChatGPTのMCP接続を作り直す |
| ChatGPTにツールがない | 接続情報を更新して新しいチャットで選択 |
| 資料リンクが401 | 取得済みのChatGPTファイルを再利用。未取得の場合だけ `read_file` で再取得 |

暗号化キーを変更すると、既存のScombZ認証は復号できなくなり、署名済みクライアント・トークン・資料リンクも使えなくなります。管理画面からScombZへ再ログインし、ChatGPTのMCP接続を作り直してください。

## 参照資料

- [Cloudflare Deployボタン](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workersの制限](https://developers.cloudflare.com/workers/platform/limits/)
- [D1の料金と無料枠](https://developers.cloudflare.com/d1/platform/pricing/)
- [MCPの認証仕様](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [OpenAIのMCP認証](https://developers.openai.com/plugins/build/auth)
- [ChatGPTへのMCP登録](https://developers.openai.com/plugins/build/app-quickstart#connect-your-mcp-server-in-chatgpt)

MIT License。教材・課題等の著作権は各権利者に帰属します。本リポジトリに大学教材や利用者のセッションは含みません。
