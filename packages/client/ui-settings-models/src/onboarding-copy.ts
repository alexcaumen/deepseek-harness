/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-08-13.1'

/** The complete editable internal-testing notice in both supported GUI locales. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: '内测声明',
    body: 'Giana CoWork Preview 目前仍处在面向私人工作台持续完善的阶段。核心插件与基础 API 会继续迭代。\n\n工作台能力保持开放、可复用、可组合。',
    continueLabel: '继续',
  },
  en: {
    title: 'Internal Testing Notice',
    body: 'Giana CoWork Preview is a private workbench that continues to evolve. Its core plugins and foundational APIs will keep improving.\n\nWorkbench capabilities remain open, reusable, and composable.',
    continueLabel: 'Continue',
  },
} as const
