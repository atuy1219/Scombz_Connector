# 認証済み学生画面の調査と対応範囲

2026-10-05に本人のSESSIONで、本人が指定した課題2件・小テスト1件・アンケート1件のHTMLを調査した。Cookie、実設問、回答、ファイル、トークンはリポジトリへ保存していない。テストは構造のみを再現した合成HTMLを使う。取得HTMLのJavaScriptは実行していない。最終提出は調査対象外。

| 対象 | 実画面から確認した契約 | この版の対応 |
| --- | --- | --- |
| ファイル課題 | `reportSubmissionForm`、multipart POST `/lms/course/report/submission`。JavaScriptは先に `/lms/course/report/upload?_cid=…` へ添付を送り、返ったfileIdをフォームへ戻す | uploadと確認画面へのPOSTを別承認。最終確認画面は停止 |
| 本文課題 | 同じフォーム、`submissionText` と `creationTime` | 対応する本文形式だけ確認画面へ。最終送信は停止 |
| 小テスト開始 | `examinationTakeForm` のPOST `/lms/course/examination/take`。CSRF・transaction token・再受験状態などを持つ | 開始の承認を独立させる |
| 小テスト問題 | 同フォームのPOST `/lms/course/examination/take?confirm`。`answer[i].examinationNo`、`answer[i].answerItem[j].answer`、チェックボックスの `!answer[…]` | 既知の `checkLog(this)` を実行せず除去し、確認画面へのPOSTだけ許可 |
| アンケート | `surveysTakeForm` のPOST `/lms/course/surveys/take`。`answerDetail[i]`、単一・複数・自由記述・行列形式。`enableSurveyItem` が空 | HTML内の順番表示処理を再現して確認画面へ。設問を飛ばす分岐は停止 |

課題の添付テンプレートには `originalFileName`、`fileId`、`rowCounter`、`fileName`、`comment` がある。ScombZのupload応答はfileId配列として検証する。既存添付の削除操作は提供せず、保存済み添付下書きがある画面は停止する。

小テストの問題画面には `/take_anssave` 自動保存、`/take_check/log`・`/take_text/log`、`/takesession`、`/taketemp`、時間切れの `/complete?timeout` が含まれる。これらは呼ばず、スクリプトも実行しない。開始調査は本人が許可した対象について実施したが、再開GETは400となり、問題画面のGET再取得を機能にはしていない。開始POSTの応答を暗号化下書きとして保持する。

アンケートの `branchType` はradio/check/multCheckという入力種類の値であり、分岐の有無を意味すると断定しない。当初の調査用選択値を使うPOSTは自動承認レビューに拒否された。その後、本人が指定した回答で確認画面までの調査を許可したため再開した。HTML内の `setBranch` / `loadSetBranch` を静的に読み、`data-nextno=0` の順番表示では各 `enableSurveyItem=1`、`takeFlag=0` になることを確認した。JavaScriptは実行せず、同じ初期化結果を設定した1回のPOSTで「回答内容確認」を取得し、指定した各回答の表示を確認した。最終送信は要求していない。

確認ページの生HTMLを確実に取得できなかった段階について、送信先やhidden回答を推測して実装しない。課題・小テスト・大学全体アンケートの最終登録は未対応。科目アンケートの最終送信・完了判定を合成応答で検証する。HTTP 200だけで提出完了とは扱わない。このPRは実データの最終提出を行わず、模擬応答で確認の分離、暗号化、世代変更、並行承認、再送防止、権限分離を検証する。

アンケート確認画面は同じ `surveysTakeForm` とPOST `/lms/course/surveys/take` を使い、hiddenの `_method=put` と「提出する」ボタンを持つ。回答を確認画面へ送る操作と、提出する操作を区別する必要がある。最終POSTは実施しておらず、対応する科目アンケートでは、承認済みの回答と確認表示を照合してから、最終送信専用の別承認を作る。必須判定は実画面の `.highlight-txt` から取り、行列設問は行ごとに確認する。Quillから復元した選択肢および行・列ラベルを承認画面へ表示する。

最終POSTは実データに対して未実施。公開結果画面の完了判定は、既存の読み取り対象 `surveysTakeResultForm` と合成フィクスチャで検証する。未知の結果レイアウトや回答日時では `verification_required` に止める。成功・通信断・303応答のいずれでも最終POSTを再送せず、本人の一覧が広告する `takeresult` のGETだけで確認する。
