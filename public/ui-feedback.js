// 詳しい状態は元のstatusに残し、画面に出す通知だけを短くする。
export function toastMessage(text) {
  if (!text) return "";
  const rules = [
    [/背面.*確認|向きの情報/, "背面カメラか確認してください"],
    [/カメラを準備/, "カメラを準備しています"],
    [/カメラの使用|HTTPS/, "HTTPSで開いてください"],
    [/カメラ.*許可|カメラを使用でき/, "カメラの許可を確認してください"],
    [/自動選択に戻/, "背面カメラへ切り替えました"],
    [/カメラ.*撮り比べ/, "カメラを撮り比べています"],
    [/カメラを取得|カメラを開始でき/, "カメラを再開してください"],
    [/カメラが停止|カメラを停止/, "カメラを停止しました"],
    [/前面に戻/, "前面でカメラを再開します"],
    [/撮影を中止/, "撮影を中止しました"],
    [/画像を切り出せ/, "もう一度撮影してください"],
    [/板面を映像/, "板面に合わせて撮影してください"],
    [/保存でき|空き容量|補正でき/, "保存できません。四隅と空き容量を確認"],
    [/端末内に保存しています/, "画像を保存しています"],
    [/補正画像と保存先|四隅を確認/, "四隅を確認して保存してください"],
    [/四隅を検出/, "板面を検出しています"],
    [/検出を中断/, "検出を中断。四隅を調整してください"],
    [/補正を中断/, "補正を中断しました"],
    [/補正しています/, "画像を補正しています"],
    [/補正画像：/, "プレビューを確認してください"],
    [/画像全体の枠/, "画像全体の枠に戻しました"],
    [/四隅を変更|元画像で四隅/, "四隅を調整して保存してください"],
  ];
  for (const [pattern, message] of rules) if (pattern.test(text)) return message;
  return text.length <= 28 ? text : "操作を確認してください";
}

export function createToast({ nodes, select, schedule = setTimeout, cancel = clearTimeout }) {
  let timer, actionable = false;
  return (text, action) => {
    if (actionable && !action) return;
    const message = toastMessage(text);
    if (!message) return;
    actionable = Boolean(action);
    cancel(timer);
    nodes.forEach(node => { node.hidden = true; });
    const node = select(); node.textContent = message; node.hidden = false;
    if (action) {
      const button = node.ownerDocument.createElement("button");
      button.type = "button"; button.textContent = "写真にも保存"; button.setAttribute("aria-label", "写真にも保存");
      button.addEventListener("click", action); node.append(button);
    }
    timer = schedule(() => { node.hidden = true; actionable = false; }, 3000);
  };
}

// スクロールする内容とは分け、掴み手のドラッグだけでシートを閉じる。
export function bindSheetDrag({ grip, sheet }) {
  let drag;
  const reset = () => { drag = null; sheet.style.transform = ""; };
  grip.addEventListener("pointerdown", event => {
    if (event.button !== 0 || event.isPrimary === false) return;
    drag = { id: event.pointerId, y: event.clientY, distance: 0 };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", event => {
    if (!drag || drag.id !== event.pointerId) return;
    drag.distance = Math.max(0, event.clientY - drag.y);
    sheet.style.transform = `translateY(${drag.distance}px)`;
  });
  grip.addEventListener("pointerup", event => {
    if (!drag || drag.id !== event.pointerId) return;
    const close = drag.distance >= 60; reset(); if (close) sheet.close();
  });
  for (const event of ["pointercancel", "lostpointercapture"]) grip.addEventListener(event, reset);
  sheet.addEventListener("close", reset);
}
