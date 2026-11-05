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
| `get_web_session` | 直接取得用のSESSIONと必須HTTPヘッダー |
| `prepare_file_download` | 通常の教材取得用。SESSIONと取得手順を1回で準備 |
| `read_file` | 教材・課題添付の直接HTTP取得手順 |
| `get_current_course` | 現在の授業候補 |
| `get_current_course_materials` | 現在の授業の公開教材一覧 |
| `get_current_course_tasks` | 現在の授業の課題・小テスト・アンケート一覧 |
| `get_current_class_context` | 現在の授業と教材・タスクを一括取得 |

課題提出、受験開始、再受験、回答送信、一時保存、出席送信は提供しません。ScombZへの通信は許可した経路へのGETのみで、リダイレクトも自動追跡しません。非公開・公開期間外の資料、要項に掲載されない未受験問題は取得できません。

前期は `first`、後期は `second`。省略時は日本時間の現在期を使い、1〜3月は前年度後期として扱います。


### 教材の直接取得

通常は`prepare_file_download(course_id, file_id)`を1回呼び、返された構造化結果を`skills/scombz/scripts/download.py`の標準入力へ渡します。`python3 .../download.py output.pdf`の引数は出力先だけにし、SESSIONを含むJSONはプロセスの標準入力に直接渡してください。JSONをコマンド引数・保存ファイル・ログへ出さないでください。`scombz:session`のOAuth承認が必要です。

準備ツールはメタデータだけを取得し、SESSIONと短いURL手順を一つの応答にまとめます。textとstructuredContentで同じデータを二重出力しません。ダウンロード・一時ID・空本文の1回再試行・PDF署名確認・容量制限はPython標準ライブラリの共通スクリプトで行い、原本をMCPへ流しません。既存ファイルは上書きしません。

既知のID・SESSIONキャッシュ・取得済み原本を再利用し、接続確認・時間割取得・ログインを繰り返しません。複数原本は逐次取得し、403・429・503では連続再試行を止めます。`Retry-After`を尊重し、人工的な操作履歴やランダムな待ち時間は作りません。サイトのブロック回避は保証しません。

共通スクリプトが使えない環境では、以下の個別ツールによる直接取得を使用できます。

教材原本の取得は、モード名・件数に関係なく直接HTTP取得に統一しています。Widget・uploadFile・Connector中継URLは削除しました。既存クライアントもツール一覧を更新してください。

1. `read_file(course_id, file_id)`で取得手順を得る。原本本体はMCPへ埋め込まない。
2. `get_web_session`でSESSIONを得る。`scombz:session`の明示的なOAuth承認が必要。既存の読み取り権限は自動昇格しない。
3. 全GETで返された`headers`を必ず使い、`Cookie: SESSION=<value>`を付ける。**返されたheadersの完全なUser-Agentは必須**。授業HTMLの追加調査には`get_web_session.request_headers`を使う。
4. `prepare_request.url`をGETして一時IDを新規発行する。空・2048文字超・HTML・改行を拒否し、trim後URLエンコードして`download_request.url_template`へ入れる。同じSESSIONで原本をGETする。課題添付はprepare_requestがnullなのでdownload_request.urlをそのまま使う。
5. HTTP 200・空でない本文・期待する形式を確認する。PDFは`%PDF-`署名を確認して本文やページを読む。空本文なら一時IDを再発行して1回だけ再試行する。

Cookieはメモリ内だけで扱い、通常の返信・ログ・コマンド引数・保存ファイルへ載せません。送信先は返されたScombZ origin限定で、自動リダイレクトを追跡しません。容量上限は実行環境側で適用します。取得済み原本は再利用します。直接HTTPを実行できないホストでは、その制約を説明します。

UAは`src/http-policy.mjs`の`USER_AGENT`一か所に定義したLinux版Chrome形式の互換性プロファイルです。現在の固定値はChrome/153.0.0.0で、最新バージョンを自動追従するものではありません。Web SESSION交換・HTML・教材取得・外部へ返す取得手順で共有します。Mobile APIへのJSON通信は従来の製品UAを維持します。`Accept`はHTML用とファイル用を分け、`Accept-Language`も共通化しています。`Sec-CH-UA`や`Sec-Fetch-*`はブラウザの状態を再現できないため追加しません。ヘッダーを整えてもHTTP/TLS実装までブラウザと同じになるわけではありません。

### 403の切り分け

2026-11-05に、同じSESSION・同じ授業URLでPython標準User-Agentは403、`Mozilla/5.0`は200になることを確認しました。一時ID発行・PDF取得もブラウザ形式のUser-Agentで成功しています。大学側の具体的な判定規則は不明です。

403やScomb_newsへの誘導だけでSESSION失効・接続元制限と断定しません。まず全GETのUser-AgentとCookie添付を確認し、同じSESSIONで比較します。401、正規のログイン画面、または/loginへの遷移で認証切れを確認したときだけ`get_web_session(refresh=true)`を1回使い、一時IDも新しく発行します。必須ヘッダーはConnector内のHTTP通信・取得手順・SESSION応答で共有し、再発を防ぎます。

読み取りツールには`readOnlyHint: true`を指定しています。資料取得を依頼済みならConnector独自の追加確認を要求しません。OAuth承認やホストの通信・ツール承認ポリシーには従います。

### 現在の授業

「今の授業の資料を取って要約して」には、まず`get_current_class_context()`で対象授業と教材を特定します。結果の`materials`から`read_file` + `get_web_session`で原本を直接取得します。コンテキスト取得だけでは教材原本を読んだことにはなりません。

4つの現在授業ツールは `at`（タイムゾーン付きISO日時、省略時は現在）、`year`、`semester`、`margin_minutes`（0〜30、省略時0）を受け取ります。日本時間の曜日と大学公式の時限（9:00–10:40、10:50–12:30、13:20–15:00、15:10–16:50、17:00–18:40、18:50–20:30）から本人のScombZ時間割を照合します。実際の授業時間帯を優先し、それ以外のときだけ前後の余裕時間を使います。

結果は `matched` / `ambiguous` / `no_class`。候補が複数なら `course: null` と `matches` を返し、自動選択しません。オンデマンドなど曜日・時限を特定できない科目は除外します。休講・祝日・補講・授業期間外は未確認で、週次時間割に基づく候補として返します。教材一覧から該当回・最新回を勝手に断定しません。

時限の出典: https://www.shibaura-it.ac.jp/campus_life/class/schedule.html

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
- 通常のOAuth権限は `scombz:read`。SESSION受け渡しには別途 `scombz:session` の本人承認が必要です。DCR、S256 PKCE、短期間の認証コード、1時間のアクセストークン、30日間の更新トークンのローテーションに対応します。
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

Secretsの設定でWorker未作成と表示された場合は、Wranglerの作成確認に従うか、先に `npx wrangler deploy` を実行してからSecretsと `npm run deploy` を設定します。WranglerはD1を自動作成し、設定へIDを反映できます。`npm run deploy` はWorkerデプロイ前に `DB` バインディングのマイグレーションを適用します。DBの作成に失敗した場合は `npx wrangler d1 create scombz-connector` で作成し、返された `database_id` を `wrangler.jsonc` に設定して再実行します。

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
| 直接取得が403 / Scomb_news | 全GETのUser-Agentが返されたheadersと一致するか確認。403だけで認証切れと断定しない |

暗号化キーを変更すると、既存のScombZ認証は復号できなくなり、署名済みクライアント・トークンも使えなくなります。管理画面からScombZへ再ログインし、ChatGPTのMCP接続を作り直してください。

## 参照資料

- [Cloudflare Deployボタン](https://developers.cloudflare.com/workers/platform/deploy-buttons/)
- [Workersの制限](https://developers.cloudflare.com/workers/platform/limits/)
- [D1の料金と無料枠](https://developers.cloudflare.com/d1/platform/pricing/)
- [MCPの認証仕様](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)
- [OpenAIのMCP認証](https://developers.openai.com/plugins/build/auth)
- [ChatGPTへのMCP登録](https://developers.openai.com/plugins/build/app-quickstart#connect-your-mcp-server-in-chatgpt)

MIT License。教材・課題等の著作権は各権利者に帰属します。本リポジトリに大学教材や利用者のセッションは含みません。

## ChatGPT側で取得・調査するための認証受け渡し

`get_web_session`は、Connectorの認証で準備したScombZ WebのSESSION CookieだけをChatGPTへ返します。この機能はHTMLやJavaScriptの取得・解析を行いません。取得・調査はChatGPTの実行環境で行います。パスワード・Mobile API Bearer・OTKEY・管理キーは返しません。既存の読み取りツールは引き続き利用できます。

既存の`scombz:read`権限だけではSESSIONを受け取れません。OAuthで`scombz:read scombz:session`を指定して再接続し、認証受け渡しを明記した承認画面で許可します。古いアクセストークン・更新トークンは読み取り権限のままで、更新時にも権限は増えません。SESSIONの取得自体にHTML取得は伴いません。不在・期限切れの場合はOTKEYで認証だけを更新します。直接アクセスで認証切れを確認した場合は`refresh=true`で再取得します。

SESSIONは本人としてWebへアクセスする認証情報で、読み取り専用に制限できません。この連携では取得・調査にのみ使用し、課題提出・受験開始・回答・一時保存などの書き込みは行いません。Cookieはメモリ内だけで使用し、会話本文・コマンド出力・共有ファイル・GitHubへ掲載せず、ScombZ以外へ送らず、リダイレクトを自動追跡しません。受け渡したCookieの大学側での失効時刻は保証できません。Connector側の認証を削除しても、既に渡したCookieが大学側で即時失効するとは限りません。

適用時は`0004_session_export_scope.sql`をD1に適用してからWorkerを更新します。`npm run deploy`はこの順序で実行します。

書き込み機能は削除しました。更新時は `0005_remove_write_support.sql` を適用し、保存済みの提出下書きと旧書き込み権限を削除します。過去のマイグレーションは適用履歴の互換性のため保持します。SESSION受け渡しは取得・調査専用で、提出や受験開始には使用しません。
