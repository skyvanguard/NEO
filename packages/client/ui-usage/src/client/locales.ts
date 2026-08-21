/** `settings.usage` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'nav': '用量',
  'title': '累计 Token 用量',
  'generated': '统计于 {when}',
  'refresh': '刷新',
  'loading': '正在汇总所有会话的用量…',
  'error': '读取用量失败',
  'retry': '重试',
  'totalTokens': '总 Token',
  'input': '输入',
  'output': '输出',
  'reasoning': '推理',
  'cacheRead': '缓存读取',
  'requests': '请求数',
  'sessions': '会话数',
  'byDay': '按天',
  'byWorkspace': '按工作区',
  'workspace': '工作区',
  'recentSessions': '最近会话',
  'session': '会话',
  'lastActive': '最近活跃',
} satisfies Record<string, string>

/** The usage namespace key union. */
export type UsageLocaleKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'nav': 'Usage',
  'title': 'Cumulative token usage',
  'generated': 'As of {when}',
  'refresh': 'Refresh',
  'loading': 'Aggregating usage across all sessions…',
  'error': 'Failed to read usage',
  'retry': 'Retry',
  'totalTokens': 'Total tokens',
  'input': 'Input',
  'output': 'Output',
  'reasoning': 'Reasoning',
  'cacheRead': 'Cache read',
  'requests': 'Requests',
  'sessions': 'Sessions',
  'byDay': 'By day',
  'byWorkspace': 'By workspace',
  'workspace': 'Workspace',
  'recentSessions': 'Recent sessions',
  'session': 'Session',
  'lastActive': 'Last active',
} satisfies Record<UsageLocaleKey, string>
