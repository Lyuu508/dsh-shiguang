export function historyRequested(text: string): boolean {
  return /(?:\/回忆|\/recall\b|记得|回忆|历史|上次|之前|以前|前几|昨天|前天|上周|上星期|上个月|去年|曾经|过去|\d{4}[-年/]\d{1,2}|last\s+(?:week|month|time)|yesterday|remember|previously)/i.test(text);
}
