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
| `read_file` | SESSIONによる直接HTTP取得手順と中継URLの代替 |
| `get_current_course` | 現在の授業候補 |
| `get_current_course_materials` | 現在の授業の公開教材一覧 |
| `get_current_course_tasks` | 現在の授業の課題・小テスト・アンケート一覧 |
| `get_current_class_context` | 現在の授業と教材・タスクを一括取得 |

課題提出、受験開始、再受験、回答送信、一時保存、出席送信は提供しません。ScombZへの通信は許可した経路へのGETのみで、リダイレクトも自動追跡しません。非公開・公開期間外の資料、要項に掲載されない未受験問題は取得できません。

前期は `first`、後期は `second`。省略時は日本時間の現在期を使い、1〜3月は前年度後期として扱います。

### 教材の直接取得

`read_file(course_id, file_id)` は科目ページから教材の存在と取得パラメーターを確認し、`direct_download` に原本の直接取得手順を返します。原本本体・base64・分割リソースは返しません。ツールの応答だけで資料を読み終えたとは扱わないでください。

1. `get_web_session` でSESSIONを取得する。`scombz:session` の明示的なOAuth承認が必要。`read_file` 自体は従来の `scombz:read` のままで、Cookieを返さない。
2. 教材の `prepare_request.url` をSESSION Cookie付きでGETし、一時ファイルIDを新規発行する。
3. 応答が空・2048文字超・HTML・改行を含む場合は停止する。有効なら前後の空白を除き、`encodeURIComponent`相当でURLエンコードして `download_request.url_template` の `{temporary_file_id}` に入れる。
4. **同じSESSION**で原本URLをGETする。課題添付は `prepare_request: null` なので `download_request.url` をそのまま使う。
5. HTTP 200だけで成功とせず、空でない本文と期待するファイル形式を確認する。PDFなら `%PDF-` の先頭署名を確認する。

古い一時IDでは200でも本文が空になることがあります。空本文のときだけ一時IDを再発行して1回再試行してください。SESSIONの認証切れが確認された場合だけ `get_web_session(refresh=true)` を使い、一時IDも新規発行します。取得済みファイルは再利用し、特定ページの確認や本文抽出は実行環境側で行います。

Cookieは実行環境のメモリ内だけで使用し、通常の返信・ログ・コマンド引数・保存ファイルへ載せません。通信先は `https://scombz.shibaura-it.ac.jp` に限定し、リダイレクトを追跡しません。原本はScombZから実行環境へ直接流れるため、MCPのtool resultサイズに左右されません。直接取得の容量上限は実行環境側で適用してください。

2026-10-07の本人指定資料で、SESSION付きの直接HTTP取得を確認しました。渡部研PDFは53,247,528バイト（50.78MiB）全体、パトハック研PDFは原本サイズ7,536,336バイト（7.19MiB）のうち先頭6MiBを取得し、HTTP 200・application/pdf・PDF署名を確認しています。原本・Cookie・実教材情報はリポジトリに保存していません。

### 中継URLと確認ポリシー

`download_url` は直接取得ができない環境だけの代替です。`download_url_role: connector_proxy_fallback_only` として返し、Connectorの `/files/` が保存済み認証でScombZから原本をストリーミング取得します。中継上限は100MiB、署名付きリンクは10分間有効です。教材はConnectorへ永続保存しません。リンクを公開・無関係なサービスへ転送しないでください。管理画面でOAuth接続を解除しても、発行済みリンクは最大10分残ります。ScombZ認証の削除で中継取得も停止します。

読み取りツールには `readOnlyHint: true` / `openWorldHint: false` を指定しています。資料取得を依頼済みならConnector独自の実体化確認を追加で要求しません。ただしSESSIONのOAuth承認やホスト側の実体化・通信・ツール承認ポリシーをサーバーから無条件許可にはできません。

### 現在の授業

「今の授業の資料を取って要約して」には `get_current_class_context()` を使い、結果の `materials` から必要なファイルを `read_file` の手順に従って直接取得します。教材原本をまとめて取得するツールではありません。

4つの現在授業ツールは `at`（タイムゾーン付きISO日時、省略時は現在）、`year`、`semester`、`margin_minutes`（0〜30、省略時0）を受け取ります。日本時間の曜日と大学公式の時限（9:00–10:40、10:50–12:30、13:20–15:00、15:10–16:50、17:00–18:40、18:50–20:30）から本人のScombZ時間割を照合します。実際の授業時間帯を優先し、それ以外のときだけ前後の余裕時間を使います。

結果は `matched` / `ambiguous` / `no_class`。候補が複数なら `course: null` と `matches` を返し、自動選択しません。オンデマンドなど曜日・時限を特定できない科目は除外します。休講・祝日・補講・授業期間外は未確認で、週次時間割に基づく候補として返します。教材一覧から該当回・最新回を勝手に断定しません。

時限の出典: https://www.shibaura-it.ac.jp/campus_life/class/schedule.html

## 通常チャットで教材原本を渡す（Widget PoC）

`open_file_in_chat(course_id, file_id)` は教材アップロードWidgetを表示します。Widgetは表示後に自動で、Workerが保存済みSESSIONを使って一時IDを発行し、原本をストリーミング取得して `window.openai.uploadFile(File)` へ渡します。通常時にアップロードボタン操作は不要です。アップロード後は `window.openai.getFileDownloadUrl({ fileId })` でChatGPT側の一時URLを取得し、MCP Appsの `ui/message` に `resource_link` を直接含めて本文確認ターンを自動送信します。`ui/message` がresource linkを受け付けないホストでは `ui/update-model-context` へ渡してからテキストメッセージを送るフォールバックを使います。SESSIONはWidget・モデルへ渡しません。PDF本体はMCP応答を通らないため、MCPの埋め込み転送上限を避けます。既存の `read_file` によるWork向け直接HTTP取得も残しています。

- 原本はConnectorへ保存しません。最大100 MiB、取得リンクは10分間有効です。期限切れ時はWidgetからリンクを更新できます。
- ChatGPTへのアップロードが完了したら `window.openai.requestClose()` でWidgetを自動的に閉じます。取得・アップロードに失敗した場合だけWidgetを残し、再試行や原本ダウンロードを表示します。
- ファイル名・種別はモデル向け結果、署名付きURLはWidget専用 `_meta` に分けます。サイズは原本未取得時点では不明（`null`）です。
- 自動アップロードは `library: true` を指定します。ただし実機では、Widgetから保存した直後のファイルがモデル側のFiles/Library検索へ即時に現れない場合があります。そのため確認用メッセージには `uploadFile` が返した `fileId` も明示し、ホスト側にFiles/Library操作がある場合は、そのfileIdを使ってモデル側からライブラリ保存・読取を試せるようにします。ChatGPTの拡張APIが未対応なら原本をダウンロードして会話へ添付する案内を表示します。
- アップロード完了はPDF本文のモデル読取成功と同義ではありません。ChatGPTが発行した一時ダウンロードURLを `resource_link` として確認用の `ui/message` に直接添付し、さらに `uploadFile` が返した `fileId` をモデル可視テキストにも渡します。resource linkだけで本文が読めない場合、ホストがFiles/Library操作を提供していれば、そのfileIdを元ファイル参照としてライブラリへ保存してから読み取るフォールバックを使います。`openai/fileParams` はChatGPTからMCPツールへファイルを入力する仕組みであり、Widgetから会話へ添付するAPIとしては扱いません。
- **PoCの未確認部分:** 自動（ユーザー操作なし）の `uploadFile` が全ChatGPTホストで許可されるか、モデル側Files/LibraryがWidgetの `fileId` を元ファイル参照として受け入れるか、`resource_link` を含む `ui/message` が新規アップロードPDFを通常の会話添付として安定してモデルへ渡せるか、ホスト固有のアップロード容量上限。失敗時だけWidgetに再試行ボタンを表示します。7.19 MiBのPDFで実ページの読取を確認してから、約50 MiBのPDFでも試してください。

WidgetのCSPはそのWorker originだけを `connectDomains` に許可します。WorkerのCORSは署名付き `/files/` のGET/OPTIONSだけで、ブラウザが送るOriginをその応答に限って反映します。ChatGPT Web/Android/iOSなどホストごとのsandbox originを固定列挙しません。管理画面・OAuth・MCPへの別originアクセスは許可しません。CORSは認証の代わりではなく、期限・科目・ファイルに結びついた署名ticketを必ず検証し、ブラウザ経由ではadmin keyやOAuth bearerをticketの代用にできません。opaqueな `Origin: null` は許可しません。

公式仕様: https://developers.openai.com/plugins/reference 、 https://developers.openai.com/plugins/build/chatgpt-ui

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

## ChatGPT側で取得・調査するための認証受け渡し

`get_web_session`は、Connectorの認証で準備したScombZ WebのSESSION CookieだけをChatGPTへ返します。この機能はHTMLやJavaScriptの取得・解析を行いません。取得・調査はChatGPTの実行環境で行います。パスワード・Mobile API Bearer・OTKEY・管理キーは返しません。既存の読み取りツールは引き続き利用できます。

既存の`scombz:read`権限だけではSESSIONを受け取れません。OAuthで`scombz:read scombz:session`を指定して再接続し、認証受け渡しを明記した承認画面で許可します。古いアクセストークン・更新トークンは読み取り権限のままで、更新時にも権限は増えません。SESSIONの取得自体にHTML取得は伴いません。不在・期限切れの場合はOTKEYで認証だけを更新します。直接アクセスで認証切れを確認した場合は`refresh=true`で再取得します。

SESSIONは本人としてWebへアクセスする認証情報で、読み取り専用に制限できません。ChatGPT側で課題提出・受験開始・回答などを書き込む前は、毎回、対象と内容を本人に示し承認を得てください。この構成ではConnectorが直接通信を監視・制御できないため、毎回の確認はChatGPT側の操作手順で守ります。Cookieはメモリ内だけで使用し、会話本文・コマンド出力・共有ファイル・GitHubへ掲載せず、ScombZ以外へ送らず、リダイレクトを自動追跡しません。受け渡したCookieの大学側での失効時刻は保証できません。Connector側の認証を削除しても、既に渡したCookieが大学側で即時失効するとは限りません。

適用時は`0004_session_export_scope.sql`をD1に適用してからWorkerを更新します。`npm run deploy`はこの順序で実行します。

書き込み機能は削除しました。更新時は `0005_remove_write_support.sql` を適用し、保存済みの提出下書きと旧書き込み権限を削除します。過去のマイグレーションは適用履歴の互換性のため保持します。SESSION受け渡しは取得・調査専用で、提出や受験開始には使用しません。
