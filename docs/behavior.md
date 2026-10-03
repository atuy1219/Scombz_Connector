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

受験開始経路 `/lms/course/examination/take` は許可しません。HTML取得はクエリキーを許可一覧で制限します。回答送信・提出等の修飾子を拒否し、リダイレクトは追跡しません。アンケートは現在表示されるGETの内容・回答確認のみを読み、集計・送信・一時保存を呼び出しません。

資料取得時は科目トップにファイルがあることを確認し、そこに表示される内部パラメーターを使います。一時IDやストレージ上のオブジェクト名を公開識別子として使用しません。Workers版はPDF原本を取得し、本文抽出はクライアントへ委ねます。

一覧の全ページ、セッションの最大寿命、大学側のアクセス履歴への影響は保証しません。「現在の一覧」「科目トップに表示される公開済みコンテンツ」のように取得範囲を返します。
