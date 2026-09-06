/** Durable settings namespace for product-wide GUI onboarding facts. */
export const WELCOME_NOTICE_SETTINGS_NAMESPACE = 'ui-onboarding'

/** Field storing the last welcome notice version the user acknowledged. */
export const WELCOME_NOTICE_ACK_FIELD = 'welcomeNoticeVersion'

/**
 * Bump only when the notice changes materially and every user should see it
 * again. The acknowledgement is compared for exact equality.
 */
export const WELCOME_NOTICE_VERSION = '2026-08-18.neo'

/** The complete editable welcome notice, per supported GUI locale. */
export const WELCOME_NOTICE_COPY = {
  zh: {
    title: 'Welcome to NEO',
    body: 'NEO is a private, local-first agent harness for offensive security. It runs entirely on your own infrastructure — a local model reasons, a local toolkit executes, and nothing leaves the box.\n\nFree your mind.',
    continueLabel: 'Continue',
  },
  en: {
    title: 'Welcome to NEO',
    body: 'NEO is a private, local-first agent harness for offensive security. It runs entirely on your own infrastructure — a local model reasons, a local toolkit executes, and nothing leaves the box.\n\nFree your mind.',
    continueLabel: 'Continue',
  },
  es: {
    title: 'Bienvenido a NEO',
    body: 'NEO es un harness de agente privado y local-first para seguridad ofensiva. Se ejecuta por completo en tu propia infraestructura: un modelo local razona, un toolkit local ejecuta, y nada sale de la máquina.\n\nLibera tu mente.',
    continueLabel: 'Continuar',
  },
} as const
