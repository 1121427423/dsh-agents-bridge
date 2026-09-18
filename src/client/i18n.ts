/**
 * dsh-agents-bridge client half — dictionaries and locale resolution.
 *
 * Bilingual (zh / en) and follows the host locale. The panel is read by whoever
 * is driving this DSH install, and the rest of the product is localized, so a
 * hardcoded English panel would be the one window that does not match.
 *
 * The host's `locale` service is OPTIONAL and is WAITED FOR with `ctx.inject`
 * (never a plugin-level `inject` — see design doc D16 and
 * `docs/client-half-slots.md` §3). Waiting reactively is not a nicety: `slots`
 * is provided by the shell core, so `apply` runs before the plugin entries that
 * publish `locale`, and a one-shot `ctx.get` read `undefined` every time — the
 * registrations below simply never happened, silently. Both the service's
 * absence and any difference in its `register` signature fall back to
 * `navigator.language`, so the panel is still localized on a host that does not
 * publish the service.
 *
 * @module dsh-agents-bridge/client/i18n
 */

/** Locale namespace used when registering with the host's locale service. */
export const LOCALE_NS = 'dsh-agents-bridge'

/** Every string the client half can render. */
export interface Dict {
  /** Status labels, one per `ClientRunStatus` (read by `statusLabel`). */
  readonly running: string
  readonly completed: string
  readonly failed: string
  readonly cancelled: string
  readonly timeout: string
  readonly panelTitle: string
  readonly indicatorRunning: string
  readonly indicatorRunningTitle: string
  readonly indicatorFailed: string
  readonly indicatorFailedTitle: string
  readonly indicatorIdle: string
  readonly indicatorIdleTitle: string
  readonly tabLabel: string
  readonly refresh: string
  readonly refreshing: string
  readonly emptyTitle: string
  readonly emptyBody: string
  readonly emptyNoSessions: string
  readonly loadingTitle: string
  readonly errorUnavailableTitle: string
  readonly errorForbidden: string
  readonly errorMissing: string
  readonly errorNetwork: string
  readonly errorInternal: string
  readonly retry: string
  readonly cancel: string
  readonly cancelConfirmTitle: string
  readonly cancelConfirmBody: string
  readonly cancelConfirmYes: string
  readonly cancelConfirmNo: string
  readonly cancelRequested: string
  readonly cancelFailed: string
  readonly cancelling: string
  readonly back: string
  readonly openOutput: string
  readonly sessionOutputTitle: string
  readonly noEventsYet: string
  readonly waitingForAgent: string
  /**
   * Notice above the transcript when it does not start at event #0 — the
   * retained window begins later. Source-neutral on purpose: the trim can come
   * from the host's ring or from this panel's own merge cap.
   */
  readonly transcriptDropped: string
  /** Row suffix carrying a finished run's exit status (`exit 0`). */
  readonly exitCode: string
  /** Row body for a FINISHED run that kept no output (restored, or spilled). */
  readonly noOutputKept: string
  readonly enginesTitle: string
  readonly enginesAvailable: string
  readonly enginesNone: string
  readonly enginesModels: string
  readonly enginesCredentialOk: string
  readonly enginesCredentialProblem: string
  readonly enginesTrackCli: string
  readonly enginesTrackDesktop: string
  /** Engine-strip button that re-WALKS the bundle roots (the expensive half). */
  readonly rescanInstalls: string
  /** What the re-scan button actually re-walks, and why it is slower. */
  readonly rescanInstallsTitle: string
  readonly pollLive: string
  readonly pollIdle: string
  readonly pollHidden: string
  readonly pollPaused: string
  readonly pollInterval: string
  readonly pollIntervalSlow: string
  readonly pollIntervalFast: string
  readonly pollIntervalOff: string
  readonly started: string
  readonly finished: string
  readonly messages: string
  readonly loadOlder: string
  readonly now: string
  readonly stepBack: string
  /** Row label for the token figure (`tokens ↑1.2k ↓340`). */
  readonly tokens: string
  /** Shown where a usage figure would go while the engine has reported none. */
  readonly instantaneous: string
  /* ── settings card (DSH 设置 → 插件) ─────────────────────────────────── */
  readonly settingsTitle: string
  /** Printed before the plugin's namespace, under the card title. */
  readonly settingsNamespaceLabel: string
  readonly settingsIntro: string
  readonly settingsSave: string
  readonly settingsSaving: string
  readonly settingsSaved: string
  readonly settingsReset: string
  readonly settingsOverridden: string
  readonly settingsInherited: string
  readonly settingsEffectLive: string
  readonly settingsEffectReload: string
  readonly settingsReadOnly: string
  readonly settingsLoadFailed: string
  /** Shown inside the expanded card before the first read lands. */
  readonly settingsLoading: string
  readonly settingsListsHint: string
  /** Accessible name of the card header while the body is closed/open. */
  readonly settingsExpand: string
  readonly settingsCollapse: string
  /** Marker on the header while the draft differs from what is stored. */
  readonly settingsUnsaved: string
  readonly settingsDiscard: string
  readonly settingsFieldDefaultCwd: string
  readonly settingsFieldMaxConcurrent: string
  readonly settingsFieldAllowedCwd: string
  readonly settingsFieldDeniedCwd: string
  readonly settingsFieldAllowedAgents: string
}

/** Simplified Chinese. */
const zh: Dict = {
  running: '运行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
  timeout: '超时',
  panelTitle: 'Agent 监工',
  indicatorRunning: '{n} 个在跑',
  indicatorRunningTitle: '有 {n} 个子 agent 正在运行，点击查看',
  indicatorFailed: '{n} 个失败',
  indicatorFailedTitle: '有 {n} 个子 agent 运行失败，点击查看',
  indicatorIdle: '无运行',
  indicatorIdleTitle: '当前没有子 agent 在运行',
  tabLabel: 'Agent',
  refresh: '刷新',
  refreshing: '刷新中…',
  emptyTitle: '还没有子 agent',
  emptyBody: '当主 agent 调用 agents_run 派活时，这里会出现每一个子 agent 的身份、状态、耗时、输出和 token 用量。',
  emptyNoSessions: '暂无会话。模型调用 agents_run 后，这里会出现一行。',
  loadingTitle: '正在读取会话…',
  errorUnavailableTitle: '监工面板连不上宿主',
  errorForbidden: '宿主拒绝了这次请求（来源校验未通过）。如果你是远程访问 DSH，请在本机打开页面。',
  errorMissing: '宿主上没有这个路由 —— 插件可能未安装或未重启。重启 DSH 后重试。',
  errorNetwork: '网络请求失败。宿主可能已重启或插件已卸载。',
  errorInternal: '宿主返回了错误：{detail}',
  retry: '重试',
  cancel: '取消',
  cancelConfirmTitle: '确定取消这个会话？',
  cancelConfirmBody: '会向子 agent 进程组发送终止信号，未完成的工作会丢失。',
  cancelConfirmYes: '确认取消',
  cancelConfirmNo: '再想想',
  cancelRequested: '已请求取消，进程正在收尾…',
  cancelFailed: '取消失败：{detail}',
  cancelling: '取消中…',
  back: '返回列表',
  openOutput: '查看输出',
  sessionOutputTitle: '输出',
  noEventsYet: '还没有事件。这个 agent 仍在工作，输出会陆续到达。',
  waitingForAgent: '等待第一个事件…',
  transcriptDropped: '最早的 {n} 个事件已不在保留窗口内；下面的编号是绝对序号。',
  exitCode: '退出码 {code}',
  noOutputKept: '这次调用没有保留输出（会话已结束）。',
  enginesTitle: '引擎可用性',
  enginesAvailable: '{n}/{total} 个引擎可用',
  enginesNone: '本机没有可驱动的引擎',
  enginesModels: '{n} 个有模型目录',
  enginesCredentialOk: '凭据正常',
  enginesCredentialProblem: '凭据异常',
  enginesTrackCli: 'CLI',
  enginesTrackDesktop: '桌面应用',
  rescanInstalls: '重新扫描安装',
  rescanInstallsTitle: '重新走一遍应用安装目录，让上次扫描之后新装的 app 出现在这里。比「刷新」慢。',
  pollLive: '实时刷新中',
  pollIdle: '全部空闲，已停止轮询',
  pollHidden: '页面已隐藏，降低刷新频率',
  pollPaused: '已暂停刷新',
  pollInterval: '刷新间隔',
  pollIntervalSlow: '慢（5 秒）',
  pollIntervalFast: '快（1 秒）',
  pollIntervalOff: '关闭自动刷新',
  started: '开始',
  finished: '结束',
  messages: '事件',
  loadOlder: '加载更早的事件',
  now: '刚刚',
  stepBack: '返回',
  tokens: 'token',
  instantaneous: 'token 未上报',
  settingsTitle: '监督桥设置',
  settingsNamespaceLabel: '插件标识：',
  settingsIntro: '这些值只影响本插件；留空即跟随内核默认或部署配置。',
  settingsSave: '保存',
  settingsSaving: '保存中…',
  settingsSaved: '已保存',
  settingsReset: '恢复默认',
  settingsOverridden: '已被用户覆盖',
  settingsInherited: '跟随部署配置',
  settingsEffectLive: '立即生效',
  settingsEffectReload: '下次加载生效',
  settingsReadOnly: '本部署未挂载设置服务，无法保存',
  settingsLoadFailed: '读取设置失败',
  settingsLoading: '读取中…',
  settingsListsHint: '多个值用换行或逗号分隔',
  settingsExpand: '展开',
  settingsCollapse: '收起',
  settingsUnsaved: '未保存',
  settingsDiscard: '放弃修改',
  settingsFieldDefaultCwd: '默认工作目录',
  settingsFieldMaxConcurrent: '最大并发会话数',
  settingsFieldAllowedCwd: '允许的工作目录白名单',
  settingsFieldDeniedCwd: '禁止的工作目录',
  settingsFieldAllowedAgents: '允许的 agent 白名单',
}

/** English. */
const en: Dict = {
  running: 'running',
  completed: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
  timeout: 'timed out',
  panelTitle: 'Agent supervisor',
  indicatorRunning: '{n} running',
  indicatorRunningTitle: '{n} delegated agent(s) are running — click to inspect',
  indicatorFailed: '{n} failed',
  indicatorFailedTitle: '{n} delegated agent(s) failed — click to inspect',
  indicatorIdle: 'idle',
  indicatorIdleTitle: 'No delegated agent is running',
  tabLabel: 'Agents',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  emptyTitle: 'No delegated agents yet',
  emptyBody: 'When the main agent calls agents_run, every delegated agent shows up here with its identity, status, elapsed time, output and token usage.',
  emptyNoSessions: 'No sessions yet. One row appears per agents_run call.',
  loadingTitle: 'Reading sessions…',
  errorUnavailableTitle: 'The supervisor panel cannot reach the host',
  errorForbidden: 'The host refused this request (origin check failed). If you reached DSH remotely, open the page on the host machine.',
  errorMissing: 'This host has no such route — the plugin is probably not installed or the host was not restarted. Restart DSH and retry.',
  errorNetwork: 'The request failed. The host may have restarted, or the plugin was unloaded.',
  errorInternal: 'The host returned an error: {detail}',
  retry: 'Retry',
  cancel: 'Cancel',
  cancelConfirmTitle: 'Cancel this session?',
  cancelConfirmBody: 'The delegated agent\'s process group is signalled and unfinished work is lost.',
  cancelConfirmYes: 'Yes, cancel it',
  cancelConfirmNo: 'Keep running',
  cancelRequested: 'Cancellation requested — the process is winding down…',
  cancelFailed: 'Cancellation failed: {detail}',
  cancelling: 'Cancelling…',
  back: 'Back to list',
  openOutput: 'View output',
  sessionOutputTitle: 'Output',
  noEventsYet: 'No events yet. The agent is still working; output will arrive as it goes.',
  waitingForAgent: 'Waiting for the first event…',
  transcriptDropped: 'The first {n} event(s) are outside the retained window; the numbers below are absolute.',
  exitCode: 'exit {code}',
  noOutputKept: 'No output retained for this run — it has already finished.',
  enginesTitle: 'Engine availability',
  enginesAvailable: '{n}/{total} engines available',
  enginesNone: 'No drivable engine on this host',
  enginesModels: '{n} with a model catalog',
  enginesCredentialOk: 'credential ok',
  enginesCredentialProblem: 'credential problem',
  enginesTrackCli: 'CLI',
  enginesTrackDesktop: 'desktop app',
  rescanInstalls: 'Rescan installs',
  rescanInstallsTitle: 'Re-walk the installed app bundles, so an app installed since the last scan shows up here. Slower than Refresh.',
  pollLive: 'Live',
  pollIdle: 'All idle — polling stopped',
  pollHidden: 'Tab hidden — polling slowed',
  pollPaused: 'Polling paused',
  pollInterval: 'Refresh interval',
  pollIntervalSlow: 'Slow (5s)',
  pollIntervalFast: 'Fast (1s)',
  pollIntervalOff: 'No auto-refresh',
  started: 'started',
  finished: 'ended',
  messages: 'events',
  loadOlder: 'Load earlier events',
  now: 'now',
  stepBack: 'Back',
  tokens: 'tokens',
  instantaneous: 'usage not reported',
  settingsTitle: 'Bridge settings',
  settingsNamespaceLabel: 'Plugin id:',
  settingsIntro: 'These values affect this plugin only; leaving one empty means "follow the kernel default or the deployment config".',
  settingsSave: 'Save',
  settingsSaving: 'Saving…',
  settingsSaved: 'Saved',
  settingsReset: 'Reset to default',
  settingsOverridden: 'overridden by user',
  settingsInherited: 'from deployment config',
  settingsEffectLive: 'takes effect now',
  settingsEffectReload: 'takes effect on next load',
  settingsReadOnly: 'this deployment mounted no settings service, so nothing can be saved',
  settingsLoadFailed: 'could not read settings',
  settingsLoading: 'Loading…',
  settingsListsHint: 'separate values with newlines or commas',
  settingsExpand: 'Expand',
  settingsCollapse: 'Collapse',
  settingsUnsaved: 'Unsaved',
  settingsDiscard: 'Discard',
  settingsFieldDefaultCwd: 'Default working directory',
  settingsFieldMaxConcurrent: 'Max concurrent sessions',
  settingsFieldAllowedCwd: 'Allowed working directories',
  settingsFieldDeniedCwd: 'Denied working directories',
  settingsFieldAllowedAgents: 'Allowed agent ids',
}

/** Both dictionaries, keyed by the locale tag the host uses. */
export const DICTS: Readonly<Record<'zh' | 'en', Dict>> = { zh, en }

/**
 * Pick a dictionary tag from a BCP-47-ish locale string.
 *
 * Anything starting with `zh` is Chinese, everything else is English — the
 * panel ships exactly two dictionaries, so a `de-DE` browser gets English
 * rather than a half-empty dictionary.
 */
export function localeTagOf(locale: string | undefined): 'zh' | 'en' {
  if (locale === undefined) return 'en'
  return /^zh\b|^zh-/i.test(locale.trim()) ? 'zh' : 'en'
}

/** Resolve the tag from the browser, tolerating a missing `navigator`. */
export function detectLocaleTag(): 'zh' | 'en' {
  try {
    if (typeof navigator === 'undefined') return 'en'
    return localeTagOf(navigator.language)
  } catch {
    return 'en'
  }
}

/**
 * Substitute `{name}` placeholders.
 *
 * Deliberately not `Intl.MessageFormat`: the panel has one placeholder shape
 * and pulling in a formatter for it would be the only reason for the client
 * bundle to grow. An unknown placeholder is left verbatim so a missing
 * substitution is visible in review, not silently blank.
 */
export function interpolate(template: string, values: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : match,
  )
}

/**
 * The translator the components hold.
 *
 * `setTag` lets the panel follow a host locale change without remounting (the
 * host publishes the locale through a service, not a page reload).
 */
export interface Translator {
  readonly current: () => Dict
  readonly tag: () => 'zh' | 'en'
  readonly setTag: (tag: 'zh' | 'en') => void
  readonly t: (key: keyof Dict, values?: Record<string, string | number>) => string
}

/** Build a translator, defaulting to the browser's locale. */
export function createTranslator(initial: 'zh' | 'en' = detectLocaleTag()): Translator {
  let tag = initial
  return {
    current: () => DICTS[tag],
    tag: () => tag,
    setTag: next => {
      tag = next
    },
    t: (key, values) => interpolate(DICTS[tag][key], values),
  }
}
