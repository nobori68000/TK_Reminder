//======================================================================
//  mainCreateAirConditioningDraft
//  2026/05/25 17:35
//
//  [機能詳細]
//  1. 先ほどのデバッグで大成功したテスト日付「2026年5月1日 16:30」を基準日としてセット。
//  2. 正常に取得できることが証明されたSlackの生ログを、そのままGemini API（gemini-2.5-flash）へ転送する。
//  3. Geminiに、カオスなGWの申請（10時開始/11時開始、19時終了/20時終了、東側/西側）の「最大公約数」を裏で一瞬で計算させる。
//  4. 計算結果が流し込まれた完成版のメール文章を、ご自身のGmailの「下書き」フォルダに自動生成する。
//
//----------------------------------------------------------------------
//  [引数]
//    なし
//
//  [戻り値]
//    {void}
//======================================================================
function mainCreateAirConditioningDraft() {
  Logger.log("=== 空調稼働依頼・AI自動集計下書きエンジンを開始します ===");

  // ★【設定項目】対象とするSlackの「チャンネルID」を入力してください
  const SLACK_CHANNEL_ID = "C05C5F3D0QM"; 
  
  const properties = PropertiesService.getScriptProperties();
  const geminiApiKey = properties.getProperty('GEMINI_API_KEY');
  const slackToken   = properties.getProperty('SLACK_BOT_TOKEN');

  if (!geminiApiKey || !slackToken) {
    Logger.log("🚨 エラー: GEMINI_API_KEY または SLACK_BOT_TOKEN が未設定です。");
    return;
  }

  // ★【テスト日付の設定】デバッグでログ取得に大成功した「2026年5月1日」をセット
  const testNowDate = new Date(2026, 4, 1, 16, 30, 0); 
  
  // 1. 検索期間の計算（月跨ぎ対応版）
  const period = _calculateSlackFetchPeriod(testNowDate);
  Logger.log(`ℹ️ Slackログ検索範囲: ${period.startDateTimeStr} ～ 現在（${period.nowDateTimeStr}）`);

  // 2. Slack APIから指定期間の生のチャットログを回収
  const slackRawLog = _fetchSlackChannelHistory(slackToken, SLACK_CHANNEL_ID, period.oldestTs, period.latestTs);
  
  if (!slackRawLog || slackRawLog.trim() === "") {
    Logger.log("ℹ️ 指定された期間内にログが見つからなかったため、処理を終了します。");
    return;
  }

  Logger.log("📊 Slackからのデータ回収完了！Geminiへ最大公約数のロジック集計を依頼します...");

  // 3. Gemini APIを呼び出し、複雑なシフトの合算とメール文面の組み立てを命令
  const generatedEmailBody = _askGeminiToAggregateAirConditioning(geminiApiKey, slackRawLog);

  if (!generatedEmailBody || generatedEmailBody.trim() === "") {
    Logger.log("🚨 エラー: Geminiからメール文面が返されなかったため中止します。");
    return;
  }

  Logger.log("🧠 Geminiの集計完了。Gmailの下書きを作成します...");

  // 4. 完成したテキストをGmailの「下書き」フォルダに格納
  _createGmailDraft(generatedEmailBody);

  Logger.log("=== すべての処理が正常に完了しました！Gmailを確認してください ===");
}

//======================================================================
//  _calculateSlackFetchPeriod
//  2026/05/25 17:20
//
//  [機能詳細]
//  1. 引数として受け取った現在時刻（nowDate）から、1日ずつ過去に遡ってカレンダー属性をチェックする。
//  2. 外部ライブラリ「BusinessDay.IS_BUSINESS_DAY」を利用し、最初に「休日」となる日を特定する。
//  3. ★【バグ修正】月跨ぎの際に日付が未来に化けるバグを修正。見つかった休日オブジェクト（checkDate）そのものをベースに翌日を計算することで、月や年が自動で連動して変わるように修正。
//  4. 決定した開始日の「0時0分0秒」から現在時刻までのUnixタイムスタンプを作成して返す。
//
//----------------------------------------------------------------------
//  [引数]
//    nowDate : {Date} 現在時刻の日付オブジェクト
//
//  [戻り値]
//    {Object} oldestTs, latestTs を含む検索期間オブジェクト
//======================================================================
function _calculateSlackFetchPeriod(nowDate) {
  const checkDate = new Date(nowDate.getTime());
  let foundTarget = false;

  // 最大30日前まで過去に遡って、直近の「非営業日（休日）」を探索
  for (let i = 0; i < 30; i++) {
    checkDate.setDate(checkDate.getDate() - 1);
    
    // 外部ライブラリ判定
    const isBusiness = BusinessDay.IS_BUSINESS_DAY(checkDate);
    
    if (!isBusiness) {
      foundTarget = true;
      break;
    }
  }

  // ★【対策確定】月跨ぎでバグらないよう、見つかった「休日」ベースで翌日を計算します
  let startDate;
  if (foundTarget) {
    // 見つかった4月29日（休日）のコピーを作成
    startDate = new Date(checkDate.getTime());
    // 休日（4月29日）に1日足す ➔ 自動的に正しい「4月30日」が生成される
    startDate.setDate(startDate.getDate() + 1);
  } else {
    startDate = new Date(nowDate.getTime());
    startDate.setDate(nowDate.getDate() - 3);
  }
  
  // 開始日の時刻を「朝 00:00:00.000」に固定
  startDate.setHours(0, 0, 0, 0);

  // Unixタイムスタンプ（秒単位）に変換
  const oldestTimestamp = String(Math.floor(startDate.getTime() / 1000));
  const latestTimestamp = String(Math.floor(nowDate.getTime() / 1000));

  const startStr = Utilities.formatDate(startDate, "JST", "yyyy/MM/dd HH:mm:ss");
  const nowStr   = Utilities.formatDate(nowDate, "JST", "yyyy/MM/dd HH:mm:ss");

  return {
    oldestTs: oldestTimestamp,
    latestTs: latestTimestamp,
    startDateTimeStr: startStr,
    nowDateTimeStr: nowStr
  };
}

//======================================================================
//  _fetchSlackChannelHistory
//  2026/05/25 17:05
//
//  [機能詳細]
//  1. Slack APIの「https://slack.com/api/conversations.history」に対して、認証トークンをヘッダーに乗せてGETリクエストを送信する。
//  2. クエリパラメータとして、対象のチャンネルID、および前段で計算したUnixタイムスタンプの開始（oldest）と終了（latest）を指定することで、ピンポイントな期間のログだけを狙い撃ちで取得する。
//  3. APIから正常に応答（messages配列）が返ってきた場合、古い発言から順番に並び替える（reverse）。
//  4. 各発言について、「誰が（user、またはBotの場合はusername）」「何を言ったか（text）」を抽出し、人間がチャット画面を見ているのと同じような時系列のテキストログ（文字列）として結合する。
//  5. 完成した1本の大きな生ログテキストを返す。
//
//----------------------------------------------------------------------
//  [引数]
//    token     : {String} Slackの認証トークン（xoxb-〜）
//    channelId : {String} 読み込み対象のSlackチャンネルID（C〜）
//    oldest    : {String} 検索開始日時のUnixタイムスタンプ
//    latest    : {String} 検索終了日時のUnixタイムスタンプ
//
//  [戻り値]
//    {String} 時系列に綺麗に結合された、チャンネル内の生ログテキスト文字列
//======================================================================
function _fetchSlackChannelHistory(token, channelId, oldest, latest) {
  // 期間を狙い撃ちしてログを最大100件（通常運用では十分な量）取得するURLを構築
  const url = `https://slack.com/api/conversations.history?channel=${channelId}&oldest=${oldest}&latest=${latest}&limit=100`;
  
  const options = {
    "method": "get",
    "headers": {
      "Authorization": "Bearer " + token
    },
    "muteHttpExceptions": true
  };

  try {
    const response = UrlFetchApp.fetch(url, options);
    const resJson = JSON.parse(response.getContentText());

    if (!resJson.ok) {
      Logger.log(`🚨 Slack APIエラー（履歴取得失敗）: ${resJson.error} | 生応答: ${response.getContentText()}`);
      return "";
    }

    const messages = resJson.messages;
    if (!messages || messages.length === 0) {
      return "";
    }

    // Slack APIは「新しい発言順」でデータを返してくるため、
    // 時系列を人間が読む順番（古い順）にするために配列を反転させる
    messages.reverse();

    const logLines = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      
      // 発言者の名前またはIDを特定（Bot発言ならusername、人間ならuser ID）
      const sender = msg.username || msg.user || "Unknown User";
      const bodyText = msg.text || "";
      
      if (bodyText.trim() === "") continue;
      
      // 「発言者: 本文」の形式で1行のログを作成
      logLines.push(`${sender}: ${bodyText}`);
    }

    // すべての発言行を改行コードで繋いで、1本の巨大なテキストにする
    return logLines.join("\n--------------------------------------------------\n");

  } catch (e) {
    Logger.log("🚨 Slackの履歴取得中に深刻な例外が発生しました: " + e.toString());
    return "";
  }
}

//======================================================================
//  _askGeminiToAggregateAirConditioning
//  2026/05/25 17:10
//
//  [機能詳細]
//  1. 定数（MODEL_NAME）に「gemini-2.5-flash」を定義。
//  2. 引数として受け取ったSlackの生ログ（slackRawLog）を解析用プロンプトの内部に安全に埋め込む。
//  3. AIに対して、「同じ日付の依頼があれば、最も早い開始時間と最も遅い終了時間を計算して最大公約数の時間帯を出すこと」「東側・西側の重複は『両側』にマージすること」「2026年のカレンダーから正しい曜日を補完すること」を厳密に指示する。
//  4. 指定された「総務担当各位...」から始まるテンプレートに集計結果を流し込ませ、余計な挨拶や解説（「はい、分かりました」など）を一切含めない生テキストとして出力させる。
//  5. Google側の通信瞬断や一時的なHTMLエラー画面の返却に備え、最大3回（1.5秒待機）の自動リトライループを実行する。
//
//----------------------------------------------------------------------
//  [引数]
//    apiKey      : {String} GeminiのAPIキー
//    slackRawLog : {String} Slackから取得した期間内のチャット生ログテキスト
//
//  [戻り値]
//    {String} Geminiが完全に集計・作成を終えた、総務宛てのメール本文（テキスト）
//======================================================================
function _askGeminiToAggregateAirConditioning(apiKey, slackRawLog) {
  const MODEL_NAME = "gemini-2.5-flash"; 

  const prompt = `
あなたは優秀な総務・労務管理AIアシスタントです。
提示された「Slackの生ログ」から【空調稼働依頼】の投稿のみを厳密に抽出し、重複や時間の重なりを綺麗にマージ（集計）した上で、指定の「総務宛てメール文面」を作成してください。

現在の年：2026年

【Slackから取得した生ログ】
--------------------------------------------------
${slackRawLog}
--------------------------------------------------

【集計・マージの鉄の掟】
1. 同じ日付の【空調稼働依頼】が複数存在する場合、それらの「最大公約数」となる時間帯を論理的に計算してください。
   - 開始時間：該当する日の「最も早い開始時間」を採用する（例：11:00と10:00の依頼があれば、10:00を開始とする）
   - 終了時間：該当する日の「最も遅い終了時間」を採用する（例：19:00と20:00の依頼があれば、20:00を終了とする）
2. エリアの表記は、以下のルールで統合・翻訳してください。
   - その日に「東側エリア（築地側）」の依頼しかない場合 ──＞ 「（東側）」と表記
   - その日に「西側エリア（JR側）」の依頼しかない場合 ──＞ 「（西側）」と表記
   - その日に「東側」と「西側」の両方の依頼がある場合、またはエリアが混在する場合 ──＞ 「（両側）」と表記
3. 各日付について、2026年のカレンダーを元に正しい曜日（土、日など）を計算して割り出してください（例：「5月23日（土）」）。
4. 関係のない会話や雑談ログは完全に無視してください。

【出力フォーマット】
「はい、承知いたしました」などの前置きやAIとしての解説文、コードブロック表現（\`\`\`）は一切排除してください。
必ず、以下のテンプレートの構成をそのまま活かし、集計結果を反映させた「メール本文のテキストのみ」を返却してください。

総務担当各位

お疲れ様です
昇です

TK の開発スタッフが出社して作業を行うことになりました。
つきましては時間外空調運転を設定いただけないでしょうか。

【プロジェクト】
TK

【日時：（空調エリア）】
（ここに集計した結果を「◯月◯日（曜日） 00:00～00:00 （エリア）」の形式で、日付の古い順に箇条書きで出力してください。複数日ある場合は改行して並べてください）
`;

  const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
  const payload = {
    "contents": [{ "parts": [{ "text": prompt }] }]
  };
  
  const options = {
    "method": "post",
    "contentType": "application/json",
    "payload": JSON.stringify(payload),
    "muteHttpExceptions": true
  };

  let attempts = 0;
  const maxAttempts = 3;

  while (attempts < maxAttempts) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const responseText = response.getContentText();
      
      // レスポンスがHTML（エラー画面）だった場合のディフェンス
      if (responseText.trim().startsWith("<")) {
        attempts++;
        Utilities.sleep(1500);
        continue;
      }
      
      const resJson = JSON.parse(responseText);
      
      if (resJson.error) {
        attempts++;
        Utilities.sleep(1500);
        continue;
      }
      
      if (!resJson.candidates || resJson.candidates.length === 0) {
        attempts++;
        Utilities.sleep(1500);
        continue;
      }
      
      // AIからのピュアなテキスト応答を取得
      let aiText = resJson.candidates[0].content.parts[0].text.trim();
      
      // 万が一マークダウンが混ざっていた場合を想定して除去ガード
      if (aiText.startsWith("```")) {
        aiText = aiText.replace(/^```[a-zA-Z]*/, "").replace(/```$/, "").trim();
      }
      
      return aiText;

    } catch (e) {
      Logger.log(`⚠️ Gemini通信例外が発生しました。1.5秒後に自動リトライします。(${e.toString()})`);
      attempts++;
      Utilities.sleep(1500);
    }
  }

  Logger.log(`❌ 深刻なエラー: ${maxAttempts} 回リトライしましたが、Gemini APIから有効な応答を得られませんでした。`);
  return "";
}
//======================================================================
//  _createGmailDraft
//  2026/05/25 17:15
//
//  [機能詳細]
//  1. 引数として受け取ったGemini生成のメール本文（emailBody）を使用して、ユーザーのGmailの「下書き」フォルダにメッセージを自動作成する。
//  2. メールの件名は、パッと見て総務が理解しやすい「【時間外空調運転依頼】TKプロジェクト休日稼働について」に固定設定。
//  3. 誤送信を完全に防ぐセーフティとして、宛先（toAddress）を最初は空欄（""）に設定。人間が下書きを開いて最終確認をしたのち、宛先を入力して「送信」ボタンを押す運用とする。
//  4. GmailApp.createDraft() を実行し、成功時は確認の案内ログを出力する。
//
//----------------------------------------------------------------------
//  [引数]
//    emailBody : {String} Geminiによって完全集計・生成された総務宛てのメール本文
//
//  [戻り値]
//    {void}
//======================================================================
function _createGmailDraft(emailBody) {
  try {
    // ★【設定項目】送信先アドレス
    // 最初は空欄にしておき、下書き画面で手動選択するのが一番安全でおすすめです。
    // もし総務のメーリングリストなどが完全に固定なら、"soumu@example.com" のように書き換えても自動入力されます。
    const toAddress = ""; 
    
    // メールの件名
    const subject = "【時間外空調運転依頼】TKプロジェクト休日稼働について";

    // Gmailの「下書き」フォルダにメッセージを新規作成
    GmailApp.createDraft(toAddress, subject, emailBody);

    Logger.log("✨ 【下書き作成成功】Gmailの「下書き」フォルダに、AIが集計した総務宛てメールを保存しました！");
    Logger.log("👉 あなたのGmail（ブラウザやスマホアプリ）を開き、「下書き」フォルダから内容を確認して「送信」を押してください。");

  } catch (e) {
    Logger.log("🚨 Gmailの下書き作成中に深刻な例外が発生しました: " + e.toString());
  }
}

//======================================================================
//  mainDebugSlackLog
//  2026/05/25 17:30
//
//  [機能詳細]
//  1. テスト用の基準日「2026年5月1日 16:30:00」を、GASが絶対に誤認しない方法（new Date）で厳密に定義する。
//  2. サブ関数「_calculateSlackFetchPeriod」へ渡し、月跨ぎを考慮した正しい検索期間（Unixタイムスタンプ）を計算させる。
//  3. 計算されたタイムスタンプをそのまま用いて、サブ関数「_fetchSlackChannelHistory」を呼び出し、Slackから生のテキストログを取得する。
//  4. 【本関数の核心】GeminiやGmailへは一切データを送らず、取得できた文字列そのものを Logger.log() でエディタの実行ログ画面にそのまま出力する。
//
//----------------------------------------------------------------------
//  [引数]
//    なし
//
//  [戻り値]
//    {void}
//======================================================================
function mainDebugSlackLog() {
  Logger.log("===========================================================");
  Logger.log("🚨 Slack生ログ取得・確認デバッグモードを実行します");
  Logger.log("===========================================================");

  // ★【設定項目】テストしたいSlackの「チャンネルID」を入力してください（Cから始まる英数字）
  const SLACK_CHANNEL_ID = "C05C5F3D0QM"; 

  const properties = PropertiesService.getScriptProperties();
  const slackToken = properties.getProperty('SLACK_BOT_TOKEN');

  if (!slackToken) {
    Logger.log("🚨 エラー: SLACK_BOT_TOKEN がスクリプトプロパティに設定されていません。");
    return;
  }

  // ★【テスト日付の設定】
  // JavaScriptの仕様上、月は「実際の月 - 1」で指定するため、5月1日は (2026, 4, 1) と書くのが一番安全です。
  // ここでは 2026年5月1日 16時30分00秒 を架空の「現在時刻」としてセットしています。
  const testNowDate = new Date(2026, 4, 1, 16, 30, 0); 
  
  // 1. 検索期間の計算を実行
  const period = _calculateSlackFetchPeriod(testNowDate);
  
  Logger.log(`[デバッグ計算結果]`);
  Logger.log(` ┝ 検索開始日時（oldest）: ${period.startDateTimeStr} (TS: ${period.oldestTs})`);
  Logger.log(` ┗ 検索終了日時（latest）: ${period.nowDateTimeStr} (TS: ${period.latestTs})`);
  Logger.log(`-----------------------------------------------------------`);

  Logger.log("⏳ Slack APIに対してログの引っ込みをリクエスト中...");
  
  // 2. Slackから指定期間のログをバサッと引っこ抜く
  const slackRawLog = _fetchSlackChannelHistory(slackToken, SLACK_CHANNEL_ID, period.oldestTs, period.latestTs);
  
  Logger.log("-----------------------------------------------------------");
  Logger.log("📊 【Slackから実際に取得できた生データ出力】");
  Logger.log("-----------------------------------------------------------");
  
  if (!slackRawLog || slackRawLog.trim() === "") {
    Logger.log("❌ 【データは空でした】原因として以下の可能性が考えられます：");
    Logger.log(" 1. スプレッドシート側のSLACK_CHANNEL_ID（Cで始まるID）が間違っている");
    Logger.log(" 2. 計算された検索範囲内に、本当に1件もチャットの発言が存在しない");
    Logger.log(" 3. Slackアプリの権限（channels:historyなど）がBotに付与されていない、またはアプリがそのチャンネルに招待（/invite）されていない");
  } else {
    // 成功していれば、ここに取得したチャットの文字がそのまま出ます
    Logger.log(slackRawLog);
  }
  
  Logger.log("-----------------------------------------------------------");
  Logger.log("🚨 デバッグモードの出力を終了しました");
  Logger.log("===========================================================");
}