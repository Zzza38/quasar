export const MOD_IDS = ['rgb', 'attention', 'backwards', 'shy', 'spin'] as const;
export type ModId = typeof MOD_IDS[number];
export const MOD_OVERRIDE_STATES = ['default', 'on', 'off'] as const;
export type ModOverrideState = typeof MOD_OVERRIDE_STATES[number];
export type ModOverrides = Record<ModId, ModOverrideState>;
export const DEFAULT_MOD_OVERRIDES: ModOverrides = { rgb: 'default', attention: 'default', backwards: 'default', shy: 'default', spin: 'default' };
export const MODS: readonly { id: ModId; name: string; description: string }[] = [
  { id: 'rgb', name: 'RGB Mode', description: 'Cycle colors across the screen.' },
  { id: 'attention', name: 'What Is an Attention Span', description: 'Play Subway Surfers and slime ASMR in existing blank spaces.' },
  { id: 'backwards', name: 'Backwards', description: 'Display all text backwards.' },
  { id: 'shy', name: "I'm Shy", description: 'Make UI elements and letters move away from the cursor.' },
  { id: 'spin', name: 'Spin', description: 'Rotate every UI element and every individual letter.' },
];
