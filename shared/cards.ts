/** Public card rules; authorization and power accounting remain server-side. */
export const CARD_RULES = {
	light_mode: { cost: 1, duration: 20000 },
	no_paste: { cost: 2, duration: 20000 },
	no_hints: { cost: 2, duration: 20000 },
	brain_teaser: { cost: 3, duration: 15000 },
	strict_compile: { cost: 4, duration: 30000 }
} as const;
export type CardId = keyof typeof CARD_RULES;
