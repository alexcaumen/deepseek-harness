/** `question` namespace dictionaries. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'error.incomplete': '请先完成这道问题。',
  'error.unanswered': '请选择一个选项或填写自定义答案。',
  'nav.prev': '上一题',
  'nav.next': '下一题',
  'nav.minimize': '收起问题卡片',
  'nav.maximize': '展开问题卡片',
  'nav.cancel': '放弃整组问题',
  'option.recommended': '推荐',
  'custom.placeholder': '输入你的答案',
  'custom.dictation.start': '开始自动语言听写',
  'custom.dictation.stop': '停止并转写',
  'custom.dictation.requestingPermission': '正在请求麦克风权限…',
  'custom.dictation.recording': '正在录音',
  'custom.dictation.transcribing': '正在转写…',
  'custom.dictation.success': '听写已添加到答案',
  'custom.dictation.failed': '听写失败：{message}',
  'custom.dictation.retry': '重试',
  'action.skip': '跳过本题',
  'action.next': '下一题',
  'plan.header': '计划待审',
  'plan.approve': '确认执行',
  'plan.decline': '拒绝',
  'plan.discuss': '去聊天里说',
} satisfies Record<string, string>

/** The question namespace key union. */
export type QuestionKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'error.incomplete': 'Please complete this question first.',
  'error.unanswered': 'Please select an option or enter a custom answer.',
  'nav.prev': 'Previous question',
  'nav.next': 'Next question',
  'nav.minimize': 'Collapse the question card',
  'nav.maximize': 'Expand the question card',
  'nav.cancel': 'Dismiss all questions',
  'option.recommended': 'Recommended',
  'custom.placeholder': 'Type your answer',
  'custom.dictation.start': 'Start automatic-language dictation',
  'custom.dictation.stop': 'Stop and transcribe',
  'custom.dictation.requestingPermission': 'Requesting microphone permission…',
  'custom.dictation.recording': 'Recording',
  'custom.dictation.transcribing': 'Transcribing…',
  'custom.dictation.success': 'Dictation added to the answer',
  'custom.dictation.failed': 'Dictation failed: {message}',
  'custom.dictation.retry': 'Retry',
  'action.skip': 'Skip this question',
  'action.next': 'Next',
  'plan.header': 'Plan review',
  'plan.approve': 'Approve',
  'plan.decline': 'Refuse',
  'plan.discuss': 'Chat about it',
} satisfies Record<QuestionKey, string>
