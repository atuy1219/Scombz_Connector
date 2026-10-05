# ScombZの読取り経路

既存の本人セッション向け実装から移植したWeb経路。ページのHTML構造が変わった場合は解析の更新が必要です。教材・課題本文、Cookie、実際の個人IDはこのリポジトリに記録しません。

| 用途 | GET経路 |
| --- | --- |
| セッション確認 | `/portal/home` |
| 時間割 | `/lms/timetable` |
| 現在のタスク | `/lms/task` |
| 科目トップ | `/lms/course` |
| 課題の要項・状態 | `/lms/course/report/submission` |
| 小テスト要項 | `/lms/course/examination/taketop` |
| 公開済み小テスト結果 | `/lms/course/examination/takeresult` |
| 科目アンケート | `/lms/course/surveys/take` / `takeresult` |
| 大学アンケート | `/portal/surveys/list` / `take` / `takeresult` |
| お知らせ一覧 | `/portal/home/information/list` |
| 教材の一時ファイルID | `/lms/course/make/tempfile` |
| 教材の原本 | `/lms/course/material/setfiledown/{filename}` |
| 課題添付 | `/lms/course/report/submission_download/{filename}` |

年度は `risyunen`、学期は `kikanCd=10`（前期） / `20`（後期）。時間割には同じ科目が複数枠に表示されるため、利用側ではcourse_idで重複排除します。

HTML内のQuill本文は文字列リテラルをJSONとして解析し、JavaScriptは実行しません。PC・モバイル向けの重複タスクは行単位で抽出します。期限の元文字列と秒を保持します。個人識別用の詳細フィールドとhiddenトークンは結果に含めません。

通常の読み取りクライアントでは受験開始経路 `/lms/course/examination/take` を許可しません。HTML取得はクエリキーを許可一覧で制限します。回答送信・提出等の修飾子を拒否し、リダイレクトは追跡しません。アンケートは現在表示されるGETの内容・回答確認のみを読み、集計・送信・一時保存を呼び出しません。

資料取得時は科目トップにファイルがあることを確認し、そこに表示される内部パラメーターを使います。一時IDやストレージ上のオブジェクト名を公開識別子として使用しません。Workers版の`read_file`はPDF原本全体を1回取得するツールです。ページ指定と`requested_pages`は提供しません。同一PDFは初回に生成されたChatGPTファイルを再利用し、本文抽出と必要に応じた複数回のページ読み取りはクライアント側のFilesへ委ねます。

一覧の全ページ、セッションの最大寿命、大学側のアクセス履歴への影響は保証しません。「現在の一覧」「科目トップに表示される公開済みコンテンツ」のように取得範囲を返します。

## 認証とWeb SESSIONキャッシュ

Mobile APIのBearerを認証の基準とし、Bearerがない場合は保存済みSESSIONだけでアクセスしません。SESSIONはBearerの世代に紐づけて暗号化し、6時間でキャッシュ期限を迎えます。期限切れ・Web側の失効時だけOTKEYから再生成します。パスワードとOTKEYは保存しません。再ログイン・ログアウトと競合した古いキャッシュ更新やBearer失効処理は、新しい認証状態を書き換えません。Webのログイン画面が続いても再試行回数を制限し、無限更新しません。

接続状態は`authenticated`（Bearer認証の保持）、`connected`（Webへの接続成功）、`reauthentication_required`（再ログインが必要）を区別します。保存済みBearerの存在だけでサーバー側の有効性を断定せず、Mobile APIの401/403で失効を確認したときに破棄します。通信障害や橋渡し失敗時は再ログインを要求しません。

## Web認証の受け渡し

`get_web_session`は`scombz:session`権限で、SESSION Cookieのみを返します。ConnectorによるHTML・教材・JavaScriptの取得は伴いません。パスワード・Mobile API Bearer・OTKEY・管理キーを返さず、取得・調査はChatGPT側へ委ねます。既存OAuthトークンはマイグレーションで`scombz:read`になり、追加権限を得るには明示的なOAuth承認が必要です。認証コード・アクセストークン・更新トークンは承認済みスコープを保持し、更新では権限を増やしません。

SESSIONそのものに読み取り専用制限や受け渡し専用の寿命は設定できません。ConnectorはChatGPT側の直接通信を制御できないため、書き込み前の毎回確認はChatGPT側の操作手順に委ねます。Cookieの値をログ・通常の返信・ファイルに出力せず、ScombZ origin限定でメモリ内使用します。

## 専用操作の確認

`scombz:write` は読み取り・SESSION権限とは独立し、既存トークンの更新で追加されません。汎用のPOST/URL指定ツールは提供しません。本人の一覧、フォームID、対象ID、CSRF、完全一致の送信先を専用アダプターで検証します。

下書きには入力値・トークン・添付メタデータを暗号化保存します。管理キーを提示して内容を確認した本人が、その操作をチェックボックスで承認した時だけ送信します。アップロード、受験開始、確認画面への遷移も別々の承認です。最終送信形式は未検証で停止します。JavaScript・自動保存・ログ・時間切れ送信は実行しません。

送信前に下書きを原子的に消費し、並行承認・リプレイを拒否します。通信失敗・リダイレクト・未知の応答は原画面での確認を促し、自動再送しません。再ログイン・ログアウト・接続解除で下書きを破棄します。添付は最大30件、multipart全体16MiB以下です。HTML取得・模擬試験の詳細と限界は [submission-html.md](submission-html.md) に記録しています。

アンケートの順番表示は、HTML内の既知の初期化処理、連続した設問番号、全選択肢の `data-nextno=0` を確認した場合だけ有効フラグを再現します。任意のJavaScriptを評価せず、未知の分岐では停止します。行列の必須設問は行ごとに回答を検証します。最終確認画面のmethod overrideは入力画面として扱いません。
