// src/server/model-notice.ts
// 組出「模型在 registry 找不到、已 fallback 到預設模型」給使用者的提示。
// issue #2 P1:原本 resolveCliModel 只寫 stderr,前端完全沒提示。
// 對外場景(hideModel)必須隱藏 model 名稱(商業資訊),只給泛用提示。

export function modelNotFoundNotice(
  pattern: string | undefined,
  hideModel: boolean,
): string {
  if (hideModel) {
    return "指定的模型目前無法使用,系統已回退到預設模型。若回應異常,請聯絡管理員確認模型設定。";
  }
  return (
    `指定的模型在 registry 找不到:${pattern || "(未指定)"},已回退到預設模型。` +
    "請確認模型名稱、registry 或金鑰設定。"
  );
}
