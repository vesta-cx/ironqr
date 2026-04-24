export type GeneratedPayloadType =
  | 'url'
  | 'text'
  | 'wifi'
  | 'phone'
  | 'sms'
  | 'email'
  | 'vcard'
  | 'calendar'
  | 'geo'
  | 'mecard';

export type PayloadFieldValue = string | boolean;

export interface GeneratedPayloadTemplate {
  readonly type: GeneratedPayloadType;
  readonly fields: Readonly<Record<string, PayloadFieldValue>>;
}

export interface ThemeColors {
  readonly id: string;
  readonly fg: string;
  readonly bg: string;
}

export interface BaseAppearanceSpec {
  readonly errorCorrection: 'L' | 'M' | 'Q' | 'H';
  readonly pixelSize: number;
  readonly moduleStyle: 'square' | 'rounded' | 'dots' | 'diamond';
  readonly capStyle: 'square' | 'circle' | 'miter';
  readonly connectionMode: 'disconnected' | 'lines';
  readonly dotSize: number;
  readonly fgColor: string;
  readonly bgColor: string;
  readonly themeId?: string;
  readonly frameText?: string;
}

export interface GeneratedRecipeStep {
  readonly kind: string;
  readonly axis?: 'x' | 'y';
  readonly direction?: 'tl' | 'tr' | 'bl' | 'br';
  readonly amount?: number;
  readonly mode?: string;
  readonly opacity?: number;
  readonly scale?: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
  readonly quality?: number;
  readonly parameters?: Readonly<Record<string, string | number | boolean>>;
}

export interface GeneratedRecipe {
  readonly id: string;
  readonly family:
    | 'perspective'
    | 'squish'
    | 'bulge'
    | 'cylinder-wrap'
    | 'noise'
    | 'blur'
    | 'quiet-zone'
    | 'deadzone'
    | 'rotation'
    | 'compression'
    | 'contrast'
    | 'background-blend'
    | 'combo';
  readonly steps: readonly GeneratedRecipeStep[];
}

export interface RecipeAssignment {
  readonly recipe: GeneratedRecipe;
  readonly baseAssetId: string;
}

const PERSPECTIVE_DIRECTIONS = ['tl', 'tr', 'bl', 'br'] as const;
const SQUISH_AXES = ['x', 'y'] as const;
const CYLINDER_AXES = ['x', 'y'] as const;
const BACKGROUND_BLEND_MODES = ['multiply', 'overlay', 'softlight'] as const;
const BACKGROUND_BLEND_OPACITIES = [0.18, 0.28, 0.38] as const;
const BACKGROUND_BLEND_SCALES = [0.55, 0.75] as const;

export const GENERATED_PAYLOAD_TEMPLATES: readonly GeneratedPayloadTemplate[] = [
  {
    type: 'url',
    fields: { url: 'https://ironqr.dev/docs' },
  },
  {
    type: 'text',
    fields: { text: 'Contact support@qrfor.ge for decoder support.' },
  },
  {
    type: 'wifi',
    fields: {
      ssid: 'ironqr-guest',
      password: 'forge-lab-2026',
      encryption: 'WPA',
      hidden: false,
    },
  },
  {
    type: 'phone',
    fields: { number: '+31 20 555 0147' },
  },
  {
    type: 'sms',
    fields: {
      number: '+31612345678',
      message: 'Hello, I need help scanning a QR check-in sign.',
    },
  },
  {
    type: 'email',
    fields: {
      to: 'support@qrfor.ge',
      subject: 'IronQR support request',
      body: 'Hi team, I need help decoding a difficult QR image.',
    },
  },
  {
    type: 'vcard',
    fields: {
      firstName: 'Iris',
      lastName: 'Forge',
      phone: '+31 20 555 0184',
      email: 'support@qrfor.ge',
      org: 'IronQR',
      title: 'Support Engineer',
      url: 'https://ironqr.dev/docs',
      address: 'Keizersgracht 313, Amsterdam',
    },
  },
  {
    type: 'calendar',
    fields: {
      title: 'IronQR demo review',
      location: 'https://ironqr.dev/docs',
      description: 'Walk through hard-case QR samples and decoder diagnostics.',
      start: '2026-05-15T10:00',
      end: '2026-05-15T10:45',
    },
  },
  {
    type: 'geo',
    fields: {
      latitude: '52.3676',
      longitude: '4.9041',
    },
  },
  {
    type: 'mecard',
    fields: {
      name: 'Forge, Iris',
      phone: '+31 20 555 0184',
      email: 'support@qrfor.ge',
      url: 'https://ironqr.dev/docs',
      address: 'Amsterdam NL',
      note: 'IronQR support contact',
    },
  },
];

export const FRAME_TEXT_BY_PAYLOAD_TYPE: Readonly<Record<GeneratedPayloadType, readonly string[]>> =
  {
    url: ['', 'ironqr.dev', 'docs'],
    text: ['', 'scan text', 'qrfor.ge'],
    wifi: ['', 'join wifi', 'ironqr-guest'],
    phone: ['', 'call support', 'qrfor.ge'],
    sms: ['', 'text us', 'ironqr.dev'],
    email: ['', 'email support', 'qrfor.ge'],
    vcard: ['', 'save contact', 'support'],
    calendar: ['', 'add event', 'demo'],
    geo: ['', 'open map', 'location'],
    mecard: ['', 'contact card', 'ironqr.dev'],
  };

const levelAmount = (level: number, min: number, step: number): number => min + step * (level - 1);

export const buildGeneratedRecipeCatalog = (): readonly GeneratedRecipe[] => {
  const recipes: GeneratedRecipe[] = [];

  for (const direction of PERSPECTIVE_DIRECTIONS) {
    for (let level = 1; level <= 10; level += 1) {
      recipes.push({
        id: `perspective:${direction}:${level}`,
        family: 'perspective',
        steps: [{ kind: 'perspective', direction, amount: levelAmount(level, 0.025, 0.015) }],
      });
    }
  }

  for (const axis of SQUISH_AXES) {
    for (let level = 1; level <= 10; level += 1) {
      recipes.push({
        id: `squish:${axis}:${level}`,
        family: 'squish',
        steps: [{ kind: 'squish', axis, amount: levelAmount(level, 0.92, -0.025) }],
      });
    }
  }

  for (let level = 1; level <= 10; level += 1) {
    recipes.push({
      id: `bulge:${level}`,
      family: 'bulge',
      steps: [{ kind: 'bulge', amount: levelAmount(level, 0.08, 0.05) }],
    });
    recipes.push({
      id: `noise:${level}`,
      family: 'noise',
      steps: [{ kind: 'noise', amount: levelAmount(level, 0.4, 0.35) }],
    });
    recipes.push({
      id: `blur:${level}`,
      family: 'blur',
      steps: [{ kind: 'blur', amount: levelAmount(level, 0.25, 0.2) }],
    });
    recipes.push({
      id: `quiet-zone:${level}`,
      family: 'quiet-zone',
      steps: [{ kind: 'quiet-zone', amount: -2 + level }],
    });
    recipes.push({
      id: `deadzone:${level}`,
      family: 'deadzone',
      steps: [
        {
          kind: 'deadzone',
          amount: levelAmount(level, 0.04, 0.015),
          parameters: {
            anchor: ['top-left', 'top', 'right', 'bottom', 'center'][(level - 1) % 5] ?? 'center',
          },
        },
      ],
    });
    recipes.push({
      id: `rotation:${level}`,
      family: 'rotation',
      steps: [{ kind: 'rotation', amount: levelAmount(level, -9, 2) }],
    });
    recipes.push({
      id: `compression:${level}`,
      family: 'compression',
      steps: [{ kind: 'compression', quality: 100 - level * 5 }],
    });
    recipes.push({
      id: `contrast:${level}`,
      family: 'contrast',
      steps: [
        {
          kind: 'contrast',
          amount: levelAmount(level, -10, 4),
          parameters: { gamma: Number(levelAmount(level, 0.88, 0.04).toFixed(2)) },
        },
      ],
    });
  }

  for (const axis of CYLINDER_AXES) {
    for (let level = 1; level <= 10; level += 1) {
      recipes.push({
        id: `cylinder-wrap:${axis}:${level}`,
        family: 'cylinder-wrap',
        steps: [{ kind: 'cylinder-wrap', axis, amount: levelAmount(level, 0.02, 0.02) }],
      });
    }
  }

  let backgroundIndex = 0;
  for (const mode of BACKGROUND_BLEND_MODES) {
    for (const opacity of BACKGROUND_BLEND_OPACITIES) {
      for (const scale of BACKGROUND_BLEND_SCALES) {
        backgroundIndex += 1;
        recipes.push({
          id: `background-blend:${backgroundIndex}`,
          family: 'background-blend',
          steps: [
            {
              kind: 'background-blend',
              mode,
              opacity,
              scale,
              parameters: {
                anchor: backgroundIndex % 2 === 0 ? 'center' : 'offset',
              },
            },
          ],
        });
      }
    }
  }

  for (let level = 1; level <= 10; level += 1) {
    recipes.push({
      id: `combo:perspective-noise:${level}`,
      family: 'combo',
      steps: [
        {
          kind: 'perspective',
          direction: PERSPECTIVE_DIRECTIONS[(level - 1) % 4]!,
          amount: levelAmount(level, 0.025, 0.012),
        },
        { kind: 'noise', amount: levelAmount(level, 0.3, 0.22) },
      ],
    });
    recipes.push({
      id: `combo:squish-background:${level}`,
      family: 'combo',
      steps: [
        {
          kind: 'squish',
          axis: SQUISH_AXES[(level - 1) % 2]!,
          amount: levelAmount(level, 0.94, -0.022),
        },
        {
          kind: 'background-blend',
          mode: BACKGROUND_BLEND_MODES[(level - 1) % BACKGROUND_BLEND_MODES.length]!,
          opacity: BACKGROUND_BLEND_OPACITIES[(level - 1) % BACKGROUND_BLEND_OPACITIES.length]!,
          scale: BACKGROUND_BLEND_SCALES[(level - 1) % BACKGROUND_BLEND_SCALES.length]!,
          parameters: { anchor: 'center' },
        },
      ],
    });
  }

  return recipes;
};

const mulberry32 = (seed: number): (() => number) => {
  let current = seed >>> 0;
  return () => {
    current |= 0;
    current = (current + 0x6d2b79f5) | 0;
    let t = Math.imul(current ^ (current >>> 15), 1 | current);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const hashSeed = (value: string): number => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

/**
 * Assign each distortion recipe to between `coverageMin` and `coverageMax` distinct bases,
 * while spreading the work roughly evenly across the base asset set.
 */
export const assignRecipesToBases = (
  recipes: readonly GeneratedRecipe[],
  baseAssetIds: readonly string[],
  seed: string,
  coverageMin = 1,
  coverageMax = 3,
): readonly RecipeAssignment[] => {
  if (baseAssetIds.length === 0) return [];

  const rng = mulberry32(hashSeed(seed));
  const load = new Map<string, number>(baseAssetIds.map((id) => [id, 0]));
  const assignments: RecipeAssignment[] = [];

  for (const recipe of recipes) {
    const coverage = Math.max(
      coverageMin,
      Math.min(coverageMax, coverageMin + Math.floor(rng() * (coverageMax - coverageMin + 1))),
    );
    const chosen = new Set<string>();

    for (let slot = 0; slot < coverage; slot += 1) {
      const candidates = [...baseAssetIds]
        .filter((id) => !chosen.has(id))
        .sort((left, right) => {
          const loadDelta = (load.get(left) ?? 0) - (load.get(right) ?? 0);
          if (loadDelta !== 0) return loadDelta;
          return left.localeCompare(right);
        });
      const candidateWindow = candidates.slice(0, Math.min(8, candidates.length));
      const selected = candidateWindow[Math.floor(rng() * candidateWindow.length)] ?? candidates[0];
      if (!selected) break;
      chosen.add(selected);
      load.set(selected, (load.get(selected) ?? 0) + 1);
      assignments.push({ recipe, baseAssetId: selected });
    }
  }

  return assignments;
};
