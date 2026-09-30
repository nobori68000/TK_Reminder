//======================================================================
//	SetExecTime
//	2026/06/01 11:35
//
//	[機能詳細]
//	1. 毎日朝3時にインフラ側の毎日定期トリガーから自動起動され、その日の
//	   配信予約を統括する。
//	2. 処理の冒頭で前日までの古いタスクキュープロパティ（予約情報）を
//	   クリーンに一括完全削除する。
//	3. スクリプトプロパティから「REMINDER_SPREADSHEET_URL」および
//	   「REMINDER_SHEET_NAME」を動的にロード。
//
//	[絶対遵守ロジック：未設定エスケープガード]
//	1. プロパティに対象のキーが未登録、あるいは空文字であった場合は安全
//	   のために処理を即座に中断（早期リターン）する。
//
//	[絶対遵守ロジック：時間固定ロジックの完全撤廃]
//	1. 外部トリガーで朝3時に起動されるため、コード内での時間固定を撤廃。
//	   「new Date()」が捕まえたリアルな「現在の実行日時」をそのまま正統な
//	   基準日（todayDate）として採用する。これにより、日中の手動デバッグ時
//	   にも正確なカレンダーマップをGeminiへ渡せるようになり、堅牢性が極大化。
//	2. Gemini APIを一括呼び出しし、本日実行すべきルール（行番号）を取得。
//	3. 該当行の投稿時間（HH:mm）を取得し、プレフィックスを付与したキーに
//	   格納後、サブ関数で未来のピンポイントトリガーを安全にビルドする。
//
//	[絶対遵守ロジック：過去時間トリガー予約の完全排除ガード]
//	1. 🚀【追加要件】手動テスト等で日中に本関数が実行された際、設定しようと
//	   する配信予定時刻が、本関数を実行している現在のリアルタイム（todayDate）
//	   よりも古い（過去の）時間である場合は、不要なトリガー構築および
//	   スクリプトプロパティ（タスクキュー）への登録処理を100%完全にスキップする。
//
//----------------------------------------------------------------------
//	[引数]
//		なし
//
//	[戻り値]
//		{void}
//======================================================================
function SetExecTime() {
	Logger.log("=== 【本番稼働】毎日定期起動：動的トリガー予約処理（SetExecTime）を開始します ===");

	const scriptProperties = PropertiesService.getScriptProperties();
	
	const SPREADSHEET_URL = scriptProperties.getProperty('REMINDER_SPREADSHEET_URL');
	const SHEET_NAME       = scriptProperties.getProperty('REMINDER_SHEET_NAME');

	if (!SPREADSHEET_URL || !SHEET_NAME) {
		Logger.log("🚨 致命的エラー: スクリプトプロパティに REMINDER_SPREADSHEET_URL または REMINDER_SHEET_NAME が設定されていません。処理を安全に中断します。");
		return;
	}

	const todayDate = new Date();
	const todayStr = Utilities.formatDate(todayDate, "JST", "yyyy/MM/dd");

	_clearExistingReminderProperties();

	const apiKey = scriptProperties.getProperty('GEMINI_API_KEY');
	if (!apiKey) {
		Logger.log("🚨 エラー: GEMINI_API_KEY が設定されていません。");
		return;
	}

	const reminderRules = _loadReminderRulesFromSheet2(SPREADSHEET_URL, SHEET_NAME);
	if (reminderRules.length === 0) {
		Logger.log("ℹ️ 処理対象のルールがないため、本日のトリガー予約を終了します。");
		return;
	}

	const calendarMap = _generateExtendedCalendarMap(todayDate);

	const resultObject = _askGeminiToIdentifyExecutableRows(apiKey, todayStr, calendarMap, reminderRules);
	if (!resultObject || !resultObject.executableRows || resultObject.executableRows.length === 0) {
		Logger.log(`ℹ️ 本日（${todayStr}）に実行すべきリマインダー行は0件です。`);
		return;
	}

	const targetRows = resultObject.executableRows;
	const prefix = "REMINDER_TASK_QUEUE_";

	for (let i = 0; i < targetRows.length; i++) {
		const rowNum = parseInt(targetRows[i].rowNumber, 10);
		const ruleIndex = rowNum - 2; 
		const rule = reminderRules[ruleIndex];

		if (!rule || !rule.postTimeStr || !rule.postTimeStr.includes(":")) {
			continue;
		}

		const postTime = rule.postTimeStr.trim();         
		
		// 🚀 【過去時間排除ガード】パースしてトリガー日時オブジェクトを作成
		const timeParts = postTime.split(":");
		const targetHh = parseInt(timeParts[0], 10);
		const targetMm = parseInt(timeParts[1], 10);
		const checkTriggerDate = new Date(todayDate.getFullYear(), todayDate.getMonth(), todayDate.getDate(), targetHh, targetMm, 0);

		// 設定しようとしている時間が現在の時刻（todayDate）以前なら、予約不要のためスキップ
		if (checkTriggerDate.getTime() <= todayDate.getTime()) {
			Logger.log(`ℹ️ 行番号 [${rowNum}] の投稿予定時間 [${postTime}] は、現在の実行時刻 [${Utilities.formatDate(todayDate, "JST", "HH:mm")}] よりも過去のため、トリガー予約およびプロパティ登録をスキップします。`);
			continue;
		}

		const propKey = prefix + postTime;          

		const existingValue = scriptProperties.getProperty(propKey);
		const newValue = existingValue ? existingValue + "," + rowNum : String(rowNum);
		scriptProperties.setProperty(propKey, newValue);

		_createNewReminderTrigger("executeReminderPost", todayDate, postTime);
	}

	Logger.log("=== 本日の動的トリガー予約（SetExecTime）がすべて正常に完了しました ===");
}

//======================================================================
//	_createNewReminderTrigger
//	2026/07/17 13:31 ※JST
//
//	[機能詳細]
//	1. 引数として受け取った基準日と時刻文字列から、トリガーをセットする
//	   具体的な日時を算出する処理を命令する。
//	2. 算出された日時情報を用いて、Google Apps Scriptの時間主導型トリガー
//	   を新規に構築・登録する処理を統括制御する。
//
//----------------------------------------------------------------------
//	[引数]
//		functionName : {String} トリガー発火時に実行する対象の関数名
//		todayDate    : {Date} 基準となる現在の実行日時オブジェクト
//		postTime     : {String} 設定対象の投稿時間文字列（"HH:mm"）
//
//	[戻り値]
//		{void}
//======================================================================
function _createNewReminderTrigger(functionName, todayDate, postTime) {
	Logger.log(`⏰ [_createNewReminderTrigger] 動的トリガー予約の制御処理を開始します。関数名: ${functionName}, 予定時刻: ${postTime}`);

	// 1. 時刻文字列と基準日から実行日時オブジェクトを計算するサブ関数を呼び出し
	const triggerDate = _calculateTriggerDateTime(todayDate, postTime);

	// 2. 計算された日時に基づきトリガーの物理生成を行うサブ関数を呼び出し
	_executeTriggerCreation(functionName, triggerDate);

	Logger.log(`⏰ [_createNewReminderTrigger] 動的トリガー予約の制御処理が正常に終了しました。`);
}

//======================================================================
//	_calculateTriggerDateTime
//	2026/07/17 13:31 ※JST
//
//	[機能詳細]
//	1. 基準日（Date型）から現在の年・月・日の情報を個別に抽出する。
//	2. "HH:mm"形式の時刻文字列をコロンで分割・パースし、時・分の数値を特定する。
//	3. 抽出した年月日と時分を結合し、トリガー設定用となる正確な日時オブジェクト
//	   を計算して呼び出し元に返却する。
//
//----------------------------------------------------------------------
//	[引数]
//		baseDate : {Date} 年月日の基準とする日付オブジェクト
//		timeStr  : {String} パース対象となる時刻文字列（"HH:mm"）
//
//	[戻り値]
//		{Date} トリガー設定用に組み立てられた日時オブジェクト
//======================================================================
function _calculateTriggerDateTime(baseDate, timeStr) {
	Logger.log(`🔍 [_calculateTriggerDateTime] 時刻文字列の解析を実行します。対象文字列: [${timeStr}]`);

	const timeParts = timeStr.split(":");
	const hours = parseInt(timeParts[0], 10);
	const minutes = parseInt(timeParts[1], 10);

	const triggerDate = new Date(
		baseDate.getFullYear(),
		baseDate.getMonth(),
		baseDate.getDate(),
		hours,
		minutes,
		0
	);

	Logger.log(`🎯 [_calculateTriggerDateTime] 設定用日時オブジェクトの算出が完了しました: ${Utilities.formatDate(triggerDate, "JST", "yyyy/MM/dd HH:mm:ss")}`);
	return triggerDate;
}

//======================================================================
//	_executeTriggerCreation
//	2026/07/17 13:31 ※JST
//
//	[機能詳細]
//	1. 指定された関数名および日時オブジェクトを基に、Google Apps Scriptの
//	   ScriptApp APIを呼び出す。
//	2. 特定日時に1回のみ実行される時間主導型トリガー（Time-driven）を
//	   物理的に生成・登録する。
//	3. 登録完了時は生成されたトリガー固有のIDをログに出力し、失敗時は
//	   キャッチした例外内容を安全にログへ記録する。
//
//----------------------------------------------------------------------
//	[引数]
//		functionName : {String} トリガーによって実行される関数名
//		triggerDate  : {Date} トリガーを発火させる特定日時オブジェクト
//
//	[戻り値]
//		{void}
//======================================================================
function _executeTriggerCreation(functionName, triggerDate) {
	Logger.log(`🚀 [_executeTriggerCreation] ScriptAppを用いた時間主導型トリガーの生成を開始します。関数名: ${functionName}`);

	try {
		const trigger = ScriptApp.newTrigger(functionName)
			.timeBased()
			.at(triggerDate)
			.create();
		
		Logger.log(`✅ [_executeTriggerCreation] トリガーの物理生成に成功しました。トリガーID: [${trigger.getUniqueId()}]`);
	} catch (e) {
		Logger.log(`🚨 [_executeTriggerCreation] トリガーの生成中に例外が発生しました: ${e.toString()}`);
	}
}

//======================================================================
// executeReminderPost
// 2026/05/29 13:41
//
// [機能詳細]
// 1. 仕込まれた指定時間に自動起動し、前後5分差分ガードを用いて今処理すべき
//    タスクを抽出する。
// 2. 7列のデータ構造のルールをロードし、ループ処理を実施する。
// 3. 🚀【追加要件】トリガー満杯エラー（上限20個）を完全に防ぐため、
//    発火した瞬間に自分自身をキックした動的トリガーをピンポイントで即座に自動消去する。
//
// [絶対遵守ロジック：C列「メール」自動判定分岐]
// 1. C列から読み込んだ「投稿先」の文字列の前後のスペースを完全にトリムし、
//    文字列が「メール」または「mail」である場合は、100%【メール送信モード】
//    へと完全に分岐させる。
// 2. それ以外（#nob_test など）の場合は、すべて100%【Slack送信モード】
//    として安全に処理する。
//
// [絶対遵守ロジック：メール送信時の宛先入れ替えガード]
// 1. C列が「メール」の場合、D列（メール（メンション））に入っている本物の
//    メールアドレス群を「Toの送信宛先」として動的に入れ替えてから
//    送信関数へ引き渡す。処理完了後はプロパティキーを抹消する。
//
//----------------------------------------------------------------------
// [引数]
//    e : {Object} 🚀【変更】トリガー発火時にGASから渡されるイベントオブジェクト
//
// [戻り値]
//    {void}
//======================================================================
function executeReminderPost(e) {
	Logger.log("=== 指定時間：リマインダー本番ポスト処理（executeReminderPost）が発火しました ===");

	// 🧹 🚀【追加】トリガー満杯防止：この実行をキックしたトリガー（自分自身）を即座にピンポイント削除
	if (e && e.triggerUid) {
		const triggers = ScriptApp.getProjectTriggers();
		for (let i = 0; i < triggers.length; i++) {
			if (triggers[i].getUniqueId() === e.triggerUid) {
				ScriptApp.deleteTrigger(triggers[i]);
				Logger.log(`🧹 自身の動的トリガー（ID: ${e.triggerUid}）を自動削除しました。`);
				break;
			}
		}
	}

	const scriptProperties = PropertiesService.getScriptProperties();
	let SPREADSHEET_URL = scriptProperties.getProperty('REMINDER_SPREADSHEET_URL');
	let SHEET_NAME       = scriptProperties.getProperty('REMINDER_SHEET_NAME');

	if (!SPREADSHEET_URL || !SHEET_NAME) {
		Logger.log("🚨 致命的エラー: スクリプトプロパティに設定がありません。");
		return;
	}

	const now = new Date();
	const prefix = "REMINDER_TASK_QUEUE_";

	const reminderRules = _loadReminderRulesFromSheet2(SPREADSHEET_URL.trim(), SHEET_NAME.trim());
	if (reminderRules.length === 0) return;

	const allProps = scriptProperties.getProperties();

	for (let key in allProps) {
		if (key.indexOf(prefix) !== 0) continue;

		const timeStr = key.substring(prefix.length);
		const timeParts = timeStr.split(":");
		const targetTimeToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), parseInt(timeParts[0], 10), parseInt(timeParts[1], 10), 0);

		if (Math.abs(now.getTime() - targetTimeToday.getTime()) / (1000 * 60) <= 5) {
			const rowValue = allProps[key]; 
			const rowNumbers = rowValue.split(",").map(num => parseInt(num.trim(), 10));

			for (let i = 0; i < rowNumbers.length; i++) {
				const currentRowNumber = rowNumbers[i];
				const rule = reminderRules[currentRowNumber - 2];

				if (rule) {
					const destinationType = rule.slackChannel ? rule.slackChannel.replace(/^[\s ]+|[\s ]+$/g, "").trim().toLowerCase() : "";
					const isMailMode = (destinationType === "メール" || destinationType === "mail");

					if (isMailMode) {
						Logger.log(`📧 行番号 [${currentRowNumber}] はC列が「メール」指定のため【メール送信モード】で配信します。`);
						const realMailTarget = rule.mentionEmails ? rule.mentionEmails.trim() : "";
						rule.slackChannel = realMailTarget; 
						_executeMailPost(rule, now);
					} else {
						Logger.log(`🚀 行番号 [${currentRowNumber}] を【Slack送信モード】で配信します。宛先チャンネル: [${rule.slackChannel}]`);
						_executeSlackPost(rule, now);
					}
				}
			}

			scriptProperties.deleteProperty(key);
		}
	}
	Logger.log("=== 本日の指定時間ポスト処理（executeReminderPost）を正常に終了しました ===");
}

//======================================================================
// _executeSlackPost
// 26/09/30 12:25 ※JST
//
// [機能詳細]
// 1. スクリプトプロパティからトークンを動的にロードする（不在時はガード）。
// 2. C列に生のメールアドレスが設定されている場合は、Slack内部固有ユーザーID
//    （U〜）を逆引きしてDM化を行う。
// 3. E列（cc）をSlackメンションに変換し、「 (cc: <@U〜>)」の形で末尾結合。
//
// [絶対遵守ロジック：件名の有無によるスレッド自動切り替え機能]
// 1. F列（件名）を置換した結果（cleanSubject）が空文字かどうかを判定する。
// 2. 件名が空欄の場合（通常型）：スレッドは作らず、1通の通常チャットメッセージ
//    （G列本文 ＋ ccメンション）として指定チャンネルへダイレクトに投稿する。
// 3. 件名に入力がある場合（スレッド型）：親メッセージとしてメンションと件名を太字で
//    投稿し、戻ってきた ts を thread_ts に指定して、詳細本文をそのスレッド内
//    へ綺麗に返信（2段階投稿）させる。
//
//----------------------------------------------------------------------
// [引数]
//    rule    : {Object} スプレッドシートから読み込んだ、該当行のルールオブジェクト
//    baseDate: {Date} 基準となる日付オブジェクト（今日）
//
// [戻り値]
//    {void}
//======================================================================
function _executeSlackPost(rule, baseDate) {
	const scriptProperties = PropertiesService.getScriptProperties();
	let token = scriptProperties.getProperty('SLACK_BOT_TOKEN') || scriptProperties.getProperty('SLACK_USER_TOKEN');

	if (!token) {
		Logger.log("🚨 致命的エラー: SLACK_BOT_TOKEN または SLACK_USER_TOKEN が設定されていないため、Slack送信をスキップします。");
		return;
	}

	let rawChannelSetting = rule.slackChannel ? rule.slackChannel.trim() : "";
	let targetDestination = rawChannelSetting;

	if (targetDestination === "") return;

	if (targetDestination.includes("@") && !targetDestination.startsWith("#") && !targetDestination.startsWith("C") && !targetDestination.startsWith("U")) {
		Logger.log(`🔍 Slack投稿先にメールアドレス検出: [${targetDestination}] ➔ ユーザーIDを逆引きしてDM化を試みます。`);
		const lookupUrl = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(targetDestination)}`;
		const lookupOptions = { "method": "get", "headers": { "Authorization": "Bearer " + token }, "muteHttpExceptions": true };
		try {
			const response = UrlFetchApp.fetch(lookupUrl, lookupOptions);
			const resJson = JSON.parse(response.getContentText());
			if (resJson.ok && resJson.user) {
				targetDestination = resJson.user.id;
				Logger.log(`🎯 個人DM宛先確定 ➔ ユーザー名: [${resJson.user.real_name}] (ID: ${targetDestination})`);
			} else {
				Logger.log(`🚨 警告: 指定されたメールアドレス [${targetDestination}] がSlack内に見つかりません。生のまま送信します: ${resJson.error}`);
			}
		} catch (e) {
			Logger.log(`🚨 投稿先メールアドレスの逆引き中に例外が発生しました: ` + e.toString());
		}
	}

	const cleanSubject = _replaceTemplateVariables(rule.subjectTemplate, baseDate).trim();
	const cleanMessage = _replaceTemplateVariables(rule.messageTemplate, baseDate);
	const cleanMention = _convertToSlackMentions(rule.mentionEmails);
	const cleanCCMention = _convertToSlackMentions(rule.ccEmails);
	
	let ccSuffix = "";
	if (cleanCCMention !== "") {
		ccSuffix = `\n(cc: ${cleanCCMention})`;
	}

	const url = "https://slack.com/api/chat.postMessage";

	if (cleanSubject === "") {
		Logger.log("ℹ️ 件名（F列）が空欄のため、【通常モード（1通完結）】でSlackへダイレクトに投稿します。");

		let finalBody = "";
		if (cleanMention !== "") {
			finalBody = cleanMention + "\n" + cleanMessage + ccSuffix;
		} else {
			finalBody = cleanMessage + ccSuffix;
		}

		const directPayload = { "channel": targetDestination, "text": finalBody };
		const directOptions = {
			"method": "post",
			"contentType": "application/json; charset=utf-8",
			"headers": { "Authorization": "Bearer " + token },
			"payload": JSON.stringify(directPayload),
			"muteHttpExceptions": true
		};

		try {
			const response = UrlFetchApp.fetch(url, directOptions);
			const resJson = JSON.parse(response.getContentText());
			if (resJson.ok) {
				Logger.log(`🚀 【通常送信成功】宛先: [${rawChannelSetting}] ➔ 正常投稿完了。`);
			} else {
				Logger.log(`🚨 【通常送信失敗】エラー: ${resJson.error}`);
			}
		} catch (e) {
			Logger.log(`🚨 通常送信中に例外が発生しました: ` + e.toString());
		}
		return; 
	}

	Logger.log(`📌 件名あり検出 ➔ 【スレッドモード】で2段階投稿を開始します。`);

	let parentText = `*${cleanSubject}*`;
	if (cleanMention !== "") {
		parentText = cleanMention + "\n" + parentText;
	}

	const parentPayload = {
		"channel": targetDestination,
		"text": parentText 
	};
	const parentOptions = {
		"method": "post",
		"contentType": "application/json; charset=utf-8",
		"headers": { "Authorization": "Bearer " + token },
		"payload": JSON.stringify(parentPayload),
		"muteHttpExceptions": true
	};

	try {
		const parentResponse = UrlFetchApp.fetch(url, parentOptions);
		const parentJson = JSON.parse(parentResponse.getContentText());

		if (parentJson.ok && parentJson.ts) {
			const threadTs = parentJson.ts;
			Logger.log(`✅ 親メッセージ（件名）投稿成功。スレッド(ts: ${threadTs})に詳細を返信します。`);

			let threadedBody = cleanMessage + ccSuffix; 

			const threadPayload = {
				"channel": targetDestination,
				"thread_ts": threadTs,
				"text": threadedBody
			};
			const threadOptions = {
				"method": "post",
				"contentType": "application/json; charset=utf-8",
				"headers": { "Authorization": "Bearer " + token },
				"payload": JSON.stringify(threadPayload),
				"muteHttpExceptions": true
			};
			
			UrlFetchApp.fetch(url, threadOptions);
			Logger.log(`🚀 スレッドへの詳細投稿が完了しました。宛先: [${rawChannelSetting}]`);
		} else {
			Logger.log(`🚨 親メッセージの投稿に失敗したため、スレッド投稿を中止しました: ${parentJson.error}`);
		}
	} catch (e) {
		Logger.log(`🚨 Slackスレッド配信中に例外が発生しました: ` + e.toString());
	}
}

//======================================================================
// _executeMailPost
// 2026/05/29 13:43
//
// [機能詳細]
// 1. C列から入れ替えられたクリーンなメールアドレスをメインのTo送信先として
//    セットする。
// 2. G列（投稿文）を本文として利用し、E列（cc）のアドレスをGmailの正規CCとして
//    設定し、GmailAppから配信する。
//
// [絶対遵守ロジック：件名置換ソースの正常化]
// 1. 件名（cleanSubject）を生成する際、確実にF列の「rule.subjectTemplate」
//    を引数に渡し、置換関数を紐付け、大文字小文字を問わず確実に
//    日付変換（西暦、月、日の動的適用）が走るように制御する。
// 2. メールの送信時は、D列の「メール」という判定用システム文字を本文に
//    一切混入させず、クリーンな投稿本文のみをGmailに乗せて配信する。
//
//----------------------------------------------------------------------
// [引数]
//    rule    : {Object} ルールオブジェクト
//    baseDate: {Date} 基準日
//
// [戻り値]
//    {void}
//======================================================================
function _executeMailPost(rule, baseDate) {
	const toAddress = rule.slackChannel ? rule.slackChannel.trim() : "";
	if (toAddress === "") return;

	const cleanSubject = _replaceTemplateVariables(rule.subjectTemplate, baseDate);
	const cleanMessage = _replaceTemplateVariables(rule.messageTemplate, baseDate);
	
	const finalMailBody = cleanMessage;

	const mailSubject = cleanSubject !== "" ? cleanSubject : "【自動配信】社内リマインダー通知";
	const ccSetting = rule.ccEmails ? rule.ccEmails.trim() : "";
	const mailOptions = ccSetting !== "" ? { cc: ccSetting } : {};

	try {
		GmailApp.sendEmail(toAddress, mailSubject, finalMailBody, mailOptions);
		Logger.log(`📧 【メール送信成功】件名: "${mailSubject}" / To: [${toAddress}] / Cc: [${ccSetting || "なし"}]`);
	} catch (e) {
		Logger.log(`🚨 メール送信エラー: ` + e.toString());
	}
}

//======================================================================
// _loadReminderRulesFromSheet2
// 2026/05/29 13:44
//
// [機能詳細]
// 1. スプレッドシートの1行目ヘッダー文字と画像の位置を100%一致させた完全版。
// 2. A列からG列までの7列分を「getDisplayValues()」でフレッシュに一括取得。
//
// [絶対遵守ロジック：インデックス番号の厳密固定]
// 1. スクリーンショットの並びを絶対の正義とし、以下のマッピングを厳守する。
//    - timingText      ➔ index 0 (A列: 実行タイミング)
//    - postTimeStr     ➔ index 1 (B列: 投稿時間)
//    - slackChannel    ➔ index 2 (C列: 投稿先)
//    - mentionEmails   ➔ index 3 (D列: メール（メンション）)
//    - ccEmails        ➔ index 4 (E列: cc)
//    - subjectTemplate ➔ index 5 (F列: 件名)
//    - messageTemplate ➔ index 6 (G列: 投稿文)
//
//----------------------------------------------------------------------
// [引数]
//    url      : {String} 対象となるGoogleスプレッドシートのURL
//    sheetName: {String} 読み込み対象のシート名
//
// [戻り値]
//    {Array<Object>} 読み込んだ行データオブジェクトの配列
//======================================================================
function _loadReminderRulesFromSheet2(url, sheetName) {
	try {
		const ss = SpreadsheetApp.openByUrl(url);
		const sheet = ss.getSheetByName(sheetName);
		
		if (!sheet) {
			Logger.log(`🚨 エラー: 指定されたシート名「${sheetName}」が見つかりません。`);
			return [];
		}

		const lastRow = sheet.getLastRow();
		if (lastRow < 2) {
			Logger.log("ℹ️ シートにデータが登録されていません。");
			return [];
		}

		const sheetValues = sheet.getRange(2, 1, lastRow - 1, 7).getDisplayValues();
		const rules = [];

		for (let i = 0; i < sheetValues.length; i++) {
			rules.push({
				timingText:      sheetValues[i][0], 
				postTimeStr:     sheetValues[i][1], 
				slackChannel:    sheetValues[i][2], 
				mentionEmails:   sheetValues[i][3], 
				ccEmails:        sheetValues[i][4], 
				subjectTemplate: sheetValues[i][5], 
				messageTemplate: sheetValues[i][6]  
			});
		}

		return rules;

	} catch (e) {
		Logger.log("🚨 エラー: スプレッドシートの読み込みに失敗しました: " + e.toString());
		return [];
	}
}

//======================================================================
// _askGeminiToIdentifyExecutableRows
// 2026/05/29 14:05
//
// [機能詳細]
// 1. スクリプトプロパティから「REMINDER_GEMINI_MODEL」を動的にロード。
// 2. スプレッドシートから読み込んだ全ルールをプロンプトに埋め込み、
//    今日当日に実行すべき行番号をAIに厳密に判定させる。
//
// [絶対遵守ロジック：営業日算定・方向性完全固定の掟]
// 1. 「営業日でない場合は一番近い営業日」という条件に対し、過去（前週の
//    金曜日など）へ遡って誤判定するバグを完全にシャットアウトする。
// 2. プロンプト内に『当日が祝日や休日等の非営業日である場合は、過去へは
//    絶対に遡らず、必ず「その日以降（直後）で最初に出現する営業日」を
//    ジャストな実行日として算定すること』という鉄の掟を絶対命令として追加。
// 3. これにより、月曜日が祝日の場合は「翌火曜日」が100%正確に算定される。
// 4. 配列内での行番号の完全重複禁止の掟も引き続き継続して適用する。
//
//----------------------------------------------------------------------
// [引数]
//    apiKey       : {String} GeminiのAPIキー
//    fakeTodayStr : {String} 今日の日付文字列
//    calendarMap  : {Array<Object>} 長期カレンダー配列
//    reminderRules: {Array<Object>} 全ルール配列
//
// [戻り値]
//    {Object|null} 判定結果オブジェクト
//======================================================================
function _askGeminiToIdentifyExecutableRows(apiKey, fakeTodayStr, calendarMap, reminderRules) {
	const scriptProperties = PropertiesService.getScriptProperties();
	const MODEL_NAME = scriptProperties.getProperty('REMINDER_GEMINI_MODEL') || "gemini-2.5-flash"; 
	Logger.log(`🧠 使用中のAI脳みそモデル: [${MODEL_NAME}]`);

	const formattedRules = [];
	for (let i = 0; i < reminderRules.length; i++) {
		const rowNum = i + 2; 
		formattedRules.push(`[行番号: ${rowNum}] 実行タイミングの条件: "${reminderRules[i].timingText}"`);
	}
	const rulesTextList = formattedRules.join("\n");

	const prompt = `
あなたは優秀な社内システムのリマインダー一括判定 engine です。
提示された「現在のカレンダー状況」と「今日の日付」を元に、エントリーされた「すべてのルール行」を精査し、本日が実行日ジャストとして完全に合致している行番号をあぶり出してください。

【検証対象としての「今日」の日付】
${fakeTodayStr}

【周辺のカレンダーマップ】
${JSON.stringify(calendarMap, null, 2)}

【検証すべきルールの一覧（行番号付き）】
${rulesTextList}

【思考・判定の鉄の掟】
1. カレンダーマップから、【検証対象としての「今日」】の曜日や営業日区分を特定します。
2. 提示された各ルールの日本語（例：「翌日が営業日でない場合」「毎月の20日以降で、一番近い営業日」など）を深く読み解きます。
3. ★【「一番近い営業日」に関する算定方向の掟（超重要）】
   - 「毎週月曜日だが、営業日でない場合は一番近い営業日」や「〇〇日でない場合は一番近い営業日」といった表現における「一番近い」とは、過去への遡回ではなく【未来への後ろ倒し】を指します。
   - もし本来の指定日（月曜日など）が祝日や休日で「非営業日」であった場合は、過去（前週の金曜日など）へ遡る判定は【絶対に禁止】します。必ず、本来の指定日よりも【未来の方向（直後・翌日以降）で最初に出現する営業日】を実行日として正しく算定してください。
4. ★【連続実行防止の掟】
   - 「〇〇日以降で一番近い営業日」や「〇〇日以降の最初の営業日」という表現は、その月の中で【条件を満たす最初の1日（ピンポイント）】のみを実行日とします。
   - まず該当月の「〇〇日以降で最初に出現する営業日」が「何月何日なのか」を特定し、検証対象である【今日の誕生日】と【完全に一致する場合のみ】を対象（executableRowsに格納）にしてください。
5. ★【超重要：完全重複禁止の掟】
   - 出力するJSONの配列 "executableRows" の中に、同じ行番号を「2回以上重複して含める」ことは【絶対に禁止】します。

【出力フォーマット】
余計な解説文や、マークダウンの \`\`\`json などの囲みは一切含めず、必ず以下のJSONフォーマットの文字列のみを返してください。

{
	"executableRows": [
		{ "rowNumber": 合致した行番号の数値 }
	],
	"globalReason": "どの行がなぜ本日該当したのか、あるいはなぜ該当しなかったのかのカレンダー日付を交えた論理的な全体説明（日本語）"
}
`;

	const url = `https://generativelanguage.googleapis.com/v1/models/${MODEL_NAME}:generateContent?key=${apiKey}`;
	const payload = { "contents": [{ "parts": [{ "text": prompt }] }] };
	const options = { "method": "post", "contentType": "application/json", "payload": JSON.stringify(payload), "muteHttpExceptions": true };

	let attempts = 0;
	const maxAttempts = 3;

	while (attempts < maxAttempts) {
		try {
			const response = UrlFetchApp.fetch(url, options);
			const responseText = response.getContentText();
			
			if (responseText.trim().startsWith("<")) {
				attempts++;
				Utilities.sleep(1500);
				continue;
			}
			
			const resJson = JSON.parse(responseText);
			if (resJson.error || !resJson.candidates || resJson.candidates.length === 0) {
				attempts++;
				Utilities.sleep(1500);
				continue;
			}
			
			let aiText = resJson.candidates[0].content.parts[0].text.trim();
			aiText = aiText.replace(/^```json/, "").replace(/```$/, "").trim();
			
			return JSON.parse(aiText);

		} catch (e) {
			attempts++;
			Utilities.sleep(1500);
		}
	}
	return null;
}

//======================================================================
// _convertToSlackMentions
// 2026/05/29 14:55
//
// [機能詳細]
// 1. カンマ区切りの文字列を綺麗に分割し、前後のスペースをクリーンアップ。
// 2. 「@channel」や「@here」はSlack公式の「<!channel>」「<!here>」に自動置換。
// 3. メールアドレスを発見した場合は、固有ユーザーID（U〜）を逆引きする。
//
// [絶対遵守ロジック：Slack公式 usergroups.list APIによる動的解決]
// 1. ★【昇さん専用・メンテナンスフリー仕様】Slackから全グループの最新
//    リストをリアルタイムに取得し、「登録名 ➔ グループID」の翻訳マップ
//    をメモリ上に自動構築する。
// 2. これにより、シート側に「@out_lead」「@marketing」など、どのような
//    グループ名が書かれていても、コード変更なしで100%自動でID（S〜）に
//    変換し、「<!subteam^SXXXXXXXXX>」のメンションを完全発火させる。
//
//----------------------------------------------------------------------
// [引数]
//    mentionStr: {String} カンマ区切りの生メンション・アドレス指定文字列
//
// [戻り値]
//    {String} Slack用メンション文字列
//======================================================================
function _convertToSlackMentions(mentionStr) {
	if (!mentionStr || mentionStr.trim() === "") return "";

	const scriptProperties = PropertiesService.getScriptProperties();
	let token = scriptProperties.getProperty('SLACK_BOT_TOKEN') || scriptProperties.getProperty('SLACK_USER_TOKEN');

	// リアルタイムに構築するグループ名 ➔ ID 翻訳マップの受け皿
	const dynamicGroupMap = {};

	// =========================================================
	// ★【Slack APIから全ユーザーグループを動的ロード】
	// =========================================================
	if (token) {
		const listUrl = "https://slack.com/api/usergroups.list";
		const listOptions = { "method": "get", "headers": { "Authorization": "Bearer " + token }, "muteHttpExceptions": true };
		try {
			const listResponse = UrlFetchApp.fetch(listUrl, listOptions);
			const listJson = JSON.parse(listResponse.getContentText());
			
			if (listJson.ok && listJson.usergroups) {
				for (let g = 0; g < listJson.usergroups.length; g++) {
					const group = listJson.usergroups[g];
					// handle（@out_lead の「out_lead」部分）を小文字にしてマッピング
					if (group.handle && group.id) {
						dynamicGroupMap[group.handle.toLowerCase()] = group.id.toUpperCase();
					}
				}
			} else {
				Logger.log(`⚠️ usergroups.list の取得に失敗しました(Scopes権限不足の可能性): ` + (listJson.error || "unknown"));
			}
		} catch (e) {
			Logger.log(`🚨 usergroups.list API通信中に例外が発生しました: ` + e.toString());
		}
	}

	const items = mentionStr.split(",").map(item => item.trim());
	const convertedMentions = [];

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		if (item === "") continue;

		// 1. 公式全体メンションの解決
		if (item.toLowerCase() === "@channel" || item.toLowerCase() === "channel") {
			convertedMentions.push("<!channel>");
			continue;
		}
		if (item.toLowerCase() === "@here" || item.toLowerCase() === "here") {
			convertedMentions.push("<!here>");
			continue;
		}

		// 頭の「@」を除去した純粋な文字列を取得（例: out_lead, marketing）
		const cleanWord = item.startsWith("@") ? item.substring(1).trim().toLowerCase() : item.toLowerCase();

		// ★ 2. 【動的グループ名解決】Slackから取得した最新のグループ名マップに存在するか判定
		if (dynamicGroupMap[cleanWord]) {
			const targetGroupId = dynamicGroupMap[cleanWord];
			convertedMentions.push(`<!subteam^${targetGroupId}>`);
			Logger.log(`🎯 グループメンション自動解決成功: [${item}] ➔ [<!subteam^${targetGroupId}>]`);
			continue;
		}

		// 3. もし直接 Sから始まるID がシートに打たれていた場合のセーフティガード
		const isDirectGroupId = /^S[A-Z0-9]{8,10}$/i.test(cleanWord);
		if (isDirectGroupId) {
			convertedMentions.push(`<!subteam^${cleanWord.toUpperCase()}>`);
			continue;
		}

		// 4. 個人のメールアドレスの逆引き解決（U〜への変換）
		const isEmail = item.includes("@");

		if (isEmail && token) {
			const url = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(item)}`;
			const options = { "method": "get", "headers": { "Authorization": "Bearer " + token }, "muteHttpExceptions": true };
			try {
				const response = UrlFetchApp.fetch(url, options);
				const resJson = JSON.parse(response.getContentText());
				if (resJson.ok && resJson.user) {
					convertedMentions.push(`<@${resJson.user.id}>`);
					continue;
				}
			} catch (e) {
				Logger.log(`🚨 users.lookupByEmail API実行中に例外が発生しました: ` + e.toString());
			}
		}

		// いずれにも該当しない文字（変換に失敗したアドレス等）はそのまま出力
		convertedMentions.push(item);
	}

	return convertedMentions.join(" ");
}

//======================================================================
// _replaceTemplateVariables
// 26/09/30 16:09 ※JST
//
// [機能詳細]
// 1. 件名テンプレート（F列）および投稿文テンプレート（G列）内の変数を、
//    Dateオブジェクトを基準に一括置換する。
// 2. コピー＆ペーストなどで意図せず文字列の両端に付与されてしまった
//    ダブルクォーテーション（"）を安全に除去する。
// 3. 互換性維持のため、既存の月シフト（M+1等）や固定変数を先に置換した上で、
//    新たに導入した動的計算タグ（例: {{D+1}}, {{D+3biz}}）を正規表現で検知し、
//    パース用サブ関数へ処理を委譲する。
//
//----------------------------------------------------------------------
// [引数]
//    template: {String} スプレッドシートから読み込んだ生テキスト（変数入り）
//    baseDate: {Date} 基準となる本日当日の日付オブジェクト
//
// [戻り値]
//    {String} すべての日付変数が変換された文字列
//======================================================================
function _replaceTemplateVariables(template, baseDate) {
	if (!template) return "";

	let text = template;
	text = text.replace(/^\s*"([\s\S]*)"\s*$/, "$1");

	// 1. 既存互換性の維持：固定の特殊タグや月単位のシフトを先に置換
	const nextMonthDate = new Date(baseDate.getTime());
	nextMonthDate.setMonth(baseDate.getMonth() + 1);
	const yyyyNext = String(nextMonthDate.getFullYear());
	const mm2Next  = String(nextMonthDate.getMonth() + 1).padStart(2, '0');
	const m1Next   = String(nextMonthDate.getMonth() + 1);

	const prevMonthDate = new Date(baseDate.getTime());
	prevMonthDate.setMonth(baseDate.getMonth() - 1);
	const yyyyPrev = String(prevMonthDate.getFullYear());
	const mm2Prev  = String(prevMonthDate.getMonth() + 1).padStart(2, '0');
	const m1Prev   = String(prevMonthDate.getMonth() + 1);

	const currentDayOfWeek = baseDate.getDay();
	const satDate = new Date(baseDate.getTime());
	satDate.setDate(baseDate.getDate() + (6 - currentDayOfWeek));
	const satStr = `${satDate.getMonth() + 1}/${satDate.getDate()}`;
	
	const sunDate = new Date(baseDate.getTime());
	sunDate.setDate(baseDate.getDate() + (7 - currentDayOfWeek));
	const sunStr = `${sunDate.getMonth() + 1}/${sunDate.getDate()}`;

	text = text.replace(/{{YYYY_NEXT_MONTH}}/gi, yyyyNext);
	text = text.replace(/{{YYYY_PREV_MONTH}}/gi, yyyyPrev);
	text = text.replace(/{{THIS_WEEKEND_SAT}}/gi, satStr);
	text = text.replace(/{{THIS_WEEKEND_SUN}}/gi, sunStr);
	text = text.replace(/{{M\+1}}/gi, m1Next);   
	text = text.replace(/{{M-1}}/gi, m1Prev);   
	text = text.replace(/{{MM\+1}}/gi, mm2Next); 
	text = text.replace(/{{MM-1}}/gi, mm2Prev); 

	// 2. 動的タグの処理：暦日および営業日の動的シフト計算
	// 例: {{YYYY}}, {{D+1}}, {{D-2biz}}, {{M+3biz}}
	const dynamicRegex = /\{\{(YYYY|MM|M|DD|D|E)(?:([-+])(\d+)(biz)?)?\}\}/gi;
	text = text.replace(dynamicRegex, function(match, element, sign, amountStr, isBiz) {
		return _processDynamicDateTag(baseDate, element, sign, amountStr, isBiz);
	});

	return text;
}

//======================================================================
// _generateExtendedCalendarMap
// 26/09/30 16:42 ※JST
//
// [機能詳細]
// 1. 基準となる日時をベースに、前後数十日間のカレンダー営業日区分マップを生成する。
// 2. Googleカレンダーのイベント参照による行事（七夕など）の誤検知を排除するため、
//    BusinessDayライブラリを利用して確実な営業日および祝日判定を行う。
//
//----------------------------------------------------------------------
// [引数]
//    baseDate: {Date} 基準日オブジェクト
//
// [戻り値]
//    {Array<Object>} 生成された営業日カレンダーオブジェクト配列
//======================================================================
function _generateExtendedCalendarMap(baseDate) {
	const calendarMap = [];
	const daysToScan = 50; 
	const startDate = new Date(baseDate.getTime());
	startDate.setDate(baseDate.getDate() - 15); 

	const weekdays = ["日", "月", "火", "水", "木", "金", "土"];

	for (let i = 0; i < daysToScan; i++) {
		const targetDate = new Date(startDate.getTime());
		targetDate.setDate(startDate.getDate() + i);

		const dateStr = Utilities.formatDate(targetDate, "JST", "yyyy/MM/dd");
		const dayOfWeekNum = targetDate.getDay();
		const dayOfWeekStr = weekdays[dayOfWeekNum];

		// 外部ライブラリを用いた確実な営業日判定
		const isBusinessDay = Common.isBusinessDayToday(targetDate);

		// 土日（0:日, 6:土）ではないが、営業日ではない日を祝日として判定
		const isHoliday = (!isBusinessDay && dayOfWeekNum !== 0 && dayOfWeekNum !== 6);

		calendarMap.push({
			"date": dateStr,
			"dayOfWeek": dayOfWeekStr,
			"isHoliday": isHoliday,
			"isBusinessDay": isBusinessDay
		});
	}

	return calendarMap;
}

//======================================================================
// _clearExistingReminderProperties
// 2026/05/29 13:49
//
// [機能詳細]
// 1. 前日分の古い「REMINDER_TASK_QUEUE_」プロパティを完全消去してお掃除する。
// 2. 🚀【追加要件】トリガー満杯エラーを防ぐため、過去に生成されて残った
//    動的トリガー（executeReminderPost）をここで一括完全削除する。
//
//----------------------------------------------------------------------
// [引数]
//    なし
//
// [戻り値]
//    {void}
//======================================================================
function _clearExistingReminderProperties() {
	const scriptProperties = PropertiesService.getScriptProperties();
	const allProps = scriptProperties.getProperties();
	const prefix = "REMINDER_TASK_QUEUE_";

	for (let key in allProps) {
		if (key.indexOf(prefix) === 0) {
			scriptProperties.deleteProperty(key);
		}
	}
	Logger.log("🧹 前日までの古い残存タスクキュープロパティをすべてクリアしました。");

	// ⏰ 🚀【追加】過去に作成された「executeReminderPost」の動的トリガーをすべて削除してクリーンにする
	const triggers = ScriptApp.getProjectTriggers();
	let deletedCount = 0;
	for (let i = 0; i < triggers.length; i++) {
		if (triggers[i].getHandlerFunction() === "executeReminderPost") {
			ScriptApp.deleteTrigger(triggers[i]);
			deletedCount++;
		}
	}
	if (deletedCount > 0) {
		Logger.log(`🧹 過去の残存動的トリガー（executeReminderPost）を ${deletedCount} 件クリアしました。`);
	}
}

//======================================================================
// testExecuteNow
// 26/09/30 12:25 ※JST
//
// [機能詳細]
// 1. 「リマインダーテスト」シートから、I2セルのテスト実行日、および
//    J2セルの結果送付先メールアドレスを動的にロード。
// 2. Gemini APIを用いて「もしその日の朝3時だったら、どの行にトリガーが
//    予約されるか」のスケジュール計算を本番と完全に同期して一括判定。
// 3. 本物のSlackチャンネルやメールには1通も実送信せず、宛先をご自身のDMへ
//    完全固定（インターセプト）した状態で、配信時間や置換後のメッセージを構築。
// 4. 【リアル再現ギミック】Slack送信（スレッド型）の場合は、J2のDM内で
//    実際に親見出し（メンション付き）を投稿し、その投稿に対して自動でスレッド返信
//    （子メッセージ）をぶら下げる処理まで完璧に再現して擬似投稿を実行する。
//
//----------------------------------------------------------------------
// [引数]
//    なし
//
// [戻り値]
//    {void}
//======================================================================
function testExecuteNow() {
	Logger.log("🧪 === 【手動テスト：本番判定シミュレーション実行】検証を開始します ===");

	const scriptProperties = PropertiesService.getScriptProperties();
	const SPREADSHEET_URL = scriptProperties.getProperty('REMINDER_SPREADSHEET_URL');
	const GEMINI_API_KEY   = scriptProperties.getProperty('GEMINI_API_KEY');
	const TEST_SHEET_NAME  = "リマインダーテスト";

	if (!SPREADSHEET_URL || !GEMINI_API_KEY) {
		Logger.log("🚨 致命的エラー: スクリプトプロパティの設定（URL/APIキー）が不足しています。");
		return;
	}

	try {
		const ss = SpreadsheetApp.openByUrl(SPREADSHEET_URL);
		const sheet = ss.getSheetByName(TEST_SHEET_NAME);
		if (!sheet) {
			Logger.log(`🚨 エラー: 「${TEST_SHEET_NAME}」シートが見つかりません。処理を中断します。`);
			return;
		}

		// 🚀 I2セルからテスト実行日を取得
		const i2Val = sheet.getRange("I2").getValue();
		let testDate = new Date();
		if (i2Val instanceof Date) {
			testDate = i2Val;
		} else if (i2Val) {
			const parsed = new Date(i2Val);
			if (!isNaN(parsed.getTime())) testDate = parsed;
		}

		// 🚀 J2セルからDM送信先のメールアドレスを取得
		const j2Val = sheet.getRange("J2").getValue().toString().trim();
		if (!j2Val || !j2Val.includes("@")) {
			Logger.log("🚨 エラー: J2セルの通知送付先メールアドレスが正しく入力されていません。");
			return;
		}

		const simulationDayStr = Utilities.formatDate(testDate, "JST", "yyyy/MM/dd");
		Logger.log(`📅 判定対象の仮想実行日: [${simulationDayStr}]`);
		Logger.log(`📧 結果のDM送信先(逆引きソース): [${j2Val}]`);

		// SlackトークンのロードとDM宛先IDの逆引き処理
		let token = scriptProperties.getProperty('SLACK_BOT_TOKEN') || scriptProperties.getProperty('SLACK_USER_TOKEN');
		if (!token) {
			Logger.log("🚨 エラー: SlackトークンがないためDM送信ができません。");
			return;
		}

		const slackUserId = _getSlackUserIdByEmail(token, j2Val);
		if (!slackUserId) {
			Logger.log(`🚨 エラー: 入力されたメールアドレス [${j2Val}] がSlack内に見つかりません。`);
			return;
		}

		// 「リマインダーテスト」シートからテスト用の全ルールをロード
		const reminderRules = _loadReminderRulesFromSheet2(SPREADSHEET_URL, TEST_SHEET_NAME);
		if (reminderRules.length === 0) return;

		const calendarMap = _generateExtendedCalendarMap(testDate);
		Logger.log("🧠 仮想カレンダーを構築し、Geminiに本番同様のスケジュール判定を要請中...");
		
		const aiResult = _askGeminiToIdentifyExecutableRows(GEMINI_API_KEY.trim(), simulationDayStr, calendarMap, reminderRules);
		if (!aiResult) {
			Logger.log("🚨 AIからの応答が空、あるいは解析不可能なフォーマットだったため判定を中止します。");
			return;
		}

		// 🚀 【第1段階】判定サマリー（AI判定根拠と対象外リスト）を1通目として送信
		let summaryText = `🧪 *【手動テスト：本番判定シミュレーション結果サマリー】*\n`;
		summaryText += `📅 *仮想実行対象日*: [${simulationDayStr}]\n`;
		summaryText += `-----------------------------------------------------------\n`;
		summaryText += `🧠 *【AIによるカレンダー判定の論理根拠】*\n${aiResult.globalReason}\n`;
		summaryText += `-----------------------------------------------------------\n`;
		summaryText += `⚠️ *本日配信対象外（自動スキップされた行）*:\n`;

		let hasExecutable = false;
		for (let idx = 0; idx < reminderRules.length; idx++) {
			const rowNumber = idx + 2;
			const rule = reminderRules[idx];
			if (!rule.timingText || rule.timingText.trim() === "") continue;

			const isExecutableByAi = aiResult.executableRows.some(function(item) {
				return parseInt(item.rowNumber, 10) === rowNumber;
			});

			if (!isExecutableByAi) {
				summaryText += ` ・[行番号: ${rowNumber}] 条件: "${rule.timingText}" ➔ 対象外\n`;
			} else {
				hasExecutable = true;
			}
		}
		
		if (!hasExecutable) {
			summaryText += ` (対象外の行はありません)\n\n💡 *本日は予約されるリマインダーメッセージは0件です。*`;
		} else {
			summaryText += `\n🔥 *以下、本日配信対象となる行の「実際の見栄え」をこのDMへ順次シミュレート投稿します。*`;
		}

		// サマリーを送信
		_sendTestDirectSlackMessage(token, slackUserId, summaryText, null);

		// 🚀 【第2段階】配信対象の行について、実際のSlack/メール投稿を見栄えごとこのDM内で完全再現
		if (hasExecutable) {
			for (let idx = 0; idx < reminderRules.length; idx++) {
				const rowNumber = idx + 2;
				const rule = reminderRules[idx];
				if (!rule.timingText || rule.timingText.trim() === "") continue;

				const isExecutableByAi = aiResult.executableRows.some(function(item) {
					return parseInt(item.rowNumber, 10) === rowNumber;
				});

				if (!isExecutableByAi) continue;

				const scheduledTime = rule.postTimeStr ? rule.postTimeStr.trim() : "（未設定）";
				const cleanSubject = _replaceTemplateVariables(rule.subjectTemplate, testDate).trim();
				const cleanMessage = _replaceTemplateVariables(rule.messageTemplate, testDate);
				const cleanMention = _convertToSlackMentions(rule.mentionEmails);
				const cleanCCMention = _convertToSlackMentions(rule.ccEmails);

				const destinationType = rule.slackChannel ? rule.slackChannel.replace(/^[\s ]+|[\s ]+$/g, "").trim().toLowerCase() : "";
				const isMailMode = (destinationType === "メール" || destinationType === "mail");

				// ナレーション（シミュレーションの区切り案内）
				let infoHeader = `===========================================================\n`;
				infoHeader += `🔔 *【配信シミュレーション再生】 行番号: ${rowNumber}* \n`;
				infoHeader += `⏰ *本来の配信予定時刻*: [今日 ${scheduledTime}:00 発火]\n`;
				infoHeader += `🎯 *本来の宛先設定(C列)*: \`${rule.slackChannel}\`\n`;
				
				if (isMailMode) {
					infoHeader += `📧 *配信モード*: メール送信 (以下の内容がメール配信されます)\n`;
					_sendTestDirectSlackMessage(token, slackUserId, infoHeader, null);

					// メール風の見た目メッセージ
					let mockMailText = `*━ 📧 擬似メール送信内容 ━━━━━━━━*\n`;
					mockMailText += `*To (宛先)* : ${cleanMention || "（未設定）"}\n`;
					mockMailText += `*Cc (共有)* : ${cleanCCMention || "なし"}\n`;
					mockMailText += `*Subject (件名)*: ${cleanSubject !== "" ? cleanSubject : "【自動配信】社内リマインダー通知"}\n`;
					mockMailText += `*Body (本文)*:\n${cleanMessage}\n`;
					mockMailText += `*━━━━━━━━━━━━━━━━━━━━━*`;
					_sendTestDirectSlackMessage(token, slackUserId, mockMailText, null);
				} else {
					infoHeader += `🚀 *配信モード*: Slackメッセージ送信 (件名: ${cleanSubject !== "" ? "スレッド型" : "通常型"})\n`;
					infoHeader += `👇 *以下、実際の見栄え（※実送信をロックし、このDM内へ安全に展開）*`;
					_sendTestDirectSlackMessage(token, slackUserId, infoHeader, null);

					// Slack投稿内容のシミュレート（文字のドッキング）
					let ccSuffix = "";
					if (cleanCCMention !== "") {
						ccSuffix = `\n(cc: ${cleanCCMention})`;
					}

					if (cleanSubject === "") {
						// 通常型（1通完結投稿）の完全再現
						let finalBody = "";
						if (cleanMention !== "") {
							finalBody = cleanMention + "\n" + cleanMessage + ccSuffix;
						} else {
							finalBody = cleanMessage + ccSuffix;
						}
						_sendTestDirectSlackMessage(token, slackUserId, finalBody, null);
					} else {
						// 🔥 スレッド型（2段階連動投稿）を、ユーザーのDMの部屋の中で完璧に再現
						// まず親メッセージ（件名とメンション）を構築して投稿し、そのシステム時間(ts)を掴む
						let parentText = `*${cleanSubject}*`;
						if (cleanMention !== "") {
							parentText = cleanMention + "\n" + parentText;
						}
						const parentTs = _sendTestDirectSlackMessage(token, slackUserId, parentText, null);
						
						if (parentTs) {
							let threadedBody = cleanMessage + ccSuffix; 
							
							// 掴んだ親のtsを thread_ts に指定して返信！これでDM内でスレッドが組まれます
							_sendTestDirectSlackMessage(token, slackUserId, threadedBody, parentTs);
						}
					}
				}
			}
		}

		Logger.log("🎉 テスト検証レポートおよびリアル再現投稿のDM送信がすべて正常に完了しました。");

	} catch (e) {
		Logger.log(`🚨 テスト実行中に致命的な例外が発生しました: ${e.toString()}`);
	}
	Logger.log("🧪 === 【手動テスト：本番判定シミュレーション実行】検証がすべて完了しました ===");
}

//======================================================================
//	_sendTestDirectSlackMessage（テスト用：指定されたDMへスレッド対応で個別投稿）
//	2026/06/01 19:35
//======================================================================
function _sendTestDirectSlackMessage(token, userId, text, threadTs) {
	const url = "https://slack.com/api/chat.postMessage";
	const payload = { "channel": userId, "text": text };
	if (threadTs) {
		payload.thread_ts = threadTs;
	}
	const options = {
		"method": "post",
		"contentType": "application/json; charset=utf-8",
		"headers": { "Authorization": "Bearer " + token },
		"payload": JSON.stringify(payload),
		"muteHttpExceptions": true
	};
	try {
		const response = UrlFetchApp.fetch(url, options);
		const json = JSON.parse(response.getContentText());
		if (json.ok && json.ts) {
			return json.ts; // スレッド返信用に投稿識別コード(ts)を返す
		}
	} catch (e) {
		Logger.log("🚨 DMへの個別シミュレート投稿に失敗しました: " + e.toString());
	}
	return null;
}

//======================================================================
//	_getSlackUserIdByEmail（メールアドレスからSlackのユーザーIDを逆引き取得）
//	2026/06/01 19:35
//======================================================================
function _getSlackUserIdByEmail(token, email) {
	const lookupUrl = `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`;
	const lookupOptions = { "method": "get", "headers": { "Authorization": "Bearer " + token }, "muteHttpExceptions": true };
	try {
		const response = UrlFetchApp.fetch(lookupUrl, lookupOptions);
		const resJson = JSON.parse(response.getContentText());
		if (resJson.ok && resJson.user) {
			return resJson.user.id;
		}
	} catch (e) {}
	return null;
}

//======================================================================
// _processDynamicDateTag
// 26/09/30 16:16 ※JST
//
// [機能詳細]
// 1. 本文テンプレート内の動的日付タグ（例: {{D+3biz}}, {{MM-1}}など）をパースし、
//    指定された基準日から暦日または営業日単位での加減算を正確に行う。
// 2. 算出した日付オブジェクトを元に、元のタグ（YYYY, MM, M, DD, D, E）に
//    対応するフォーマット済み文字列を呼び出し元（_replaceTemplateVariables）へ返却する。
//
//----------------------------------------------------------------------
// [引数]
//    baseDate : {Date} 基準となる日付オブジェクト（今日など）
//    element  : {String} 抽出対象の要素（YYYY, MM, M, DD, D, E のいずれか）
//    sign     : {String|undefined} 符号（"+" または "-"）。無指定の場合は undefined
//    amountStr: {String|undefined} 加減算する数値の文字列。無指定の場合は undefined
//    isBiz    : {String|undefined} "biz" が付与されているか。付与時は営業日計算
//
// [戻り値]
//    {String} 計算・フォーマット済みの置換用日付文字列
//======================================================================
function _processDynamicDateTag(baseDate, element, sign, amountStr, isBiz) {
	let targetDate = new Date(baseDate.getTime());
	const amount = amountStr ? parseInt(amountStr, 10) : 0;
	const isFuture = (sign === "+");

	if (amount > 0) {
		if (isBiz && isBiz.toLowerCase() === "biz") {
			// 営業日ベースでの加減算サブ関数へ委譲
			targetDate = _calculateBusinessDaysShift(targetDate, amount, isFuture);
		} else {
			// 単純な暦日ベースでの加減算
			const direction = isFuture ? 1 : -1;
			targetDate.setDate(targetDate.getDate() + (amount * direction));
		}
	}

	const el = element.toUpperCase();
	switch (el) {
		case "YYYY":
			return String(targetDate.getFullYear());
		case "MM":
			return String(targetDate.getMonth() + 1).padStart(2, '0');
		case "M":
			return String(targetDate.getMonth() + 1);
		case "DD":
			return String(targetDate.getDate()).padStart(2, '0');
		case "D":
			return String(targetDate.getDate());
		case "E":
			const weekdays = ["日", "月", "火", "水", "木", "金", "土"];
			return weekdays[targetDate.getDay()];
		default:
			return match; // 予期せぬ要素の場合はそのまま返す（安全倒し）
	}
}

//======================================================================
// _calculateBusinessDaysShift
// 26/09/30 16:17 ※JST
//
// [機能詳細]
// 1. 基準日から指定された営業日数分だけ、未来または過去へ日付をシフトする。
// 2. BusinessDayライブラリを利用し、土日および祝日をスキップしながら
//    有効な営業日のみをカウントして目的の日付を算出する。
//
//----------------------------------------------------------------------
// [引数]
//    baseDate: {Date} 基準となる日付オブジェクト
//    amount  : {Number} シフトする営業日数
//    isFuture: {Boolean} true=未来方向へのシフト, false=過去方向へのシフト
//
// [戻り値]
//    {Date} 算出された営業日シフト後の日付オブジェクト
//======================================================================
function _calculateBusinessDaysShift(baseDate, amount, isFuture) {
	let targetDate = new Date(baseDate.getTime());
	let count = 0;
	const direction = isFuture ? 1 : -1;

	while (count < amount) {
		targetDate.setDate(targetDate.getDate() + direction);
		// 外部ライブラリを用いて営業日判定
		if (Common.isBusinessDayTodayY(targetDate)) {
			count++;
		}
	}

	return targetDate;
}

