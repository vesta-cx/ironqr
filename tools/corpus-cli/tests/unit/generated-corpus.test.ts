import { describe, expect, it } from 'bun:test';
import {
  assignRecipesToBases,
  buildGeneratedRecipeCatalog,
  GENERATED_PAYLOAD_TEMPLATES,
} from '../../src/generated/spec.js';

describe('generated corpus spec', () => {
  it('defines one believable payload template per supported payload type', () => {
    expect(GENERATED_PAYLOAD_TEMPLATES.map((template) => template.type)).toEqual([
      'url',
      'text',
      'wifi',
      'phone',
      'sms',
      'email',
      'vcard',
      'calendar',
      'geo',
      'mecard',
    ]);
    expect(
      GENERATED_PAYLOAD_TEMPLATES.find((template) => template.type === 'email')?.fields,
    ).toMatchObject({
      to: 'support@qrfor.ge',
    });
    expect(
      GENERATED_PAYLOAD_TEMPLATES.find((template) => template.type === 'url')?.fields,
    ).toMatchObject({
      url: 'https://ironqr.dev/docs',
    });
  });

  it('builds a broad distortion recipe catalog with the required families', () => {
    const recipes = buildGeneratedRecipeCatalog();
    const families = new Set(recipes.map((recipe) => recipe.family));

    expect(recipes.length).toBeGreaterThanOrEqual(170);
    expect(families).toEqual(
      new Set([
        'perspective',
        'squish',
        'bulge',
        'cylinder-wrap',
        'noise',
        'blur',
        'quiet-zone',
        'deadzone',
        'rotation',
        'compression',
        'contrast',
        'background-blend',
        'combo',
      ]),
    );
  });

  it('assigns every recipe to between one and three distinct bases', () => {
    const recipes = buildGeneratedRecipeCatalog().slice(0, 40);
    const baseAssetIds = Array.from({ length: 12 }, (_, index) => `base-${index}`);
    const assignments = assignRecipesToBases(recipes, baseAssetIds, 'seed-1', 1, 3);

    const coverage = new Map<string, Set<string>>();
    for (const assignment of assignments) {
      const recipeCoverage = coverage.get(assignment.recipe.id) ?? new Set<string>();
      recipeCoverage.add(assignment.baseAssetId);
      coverage.set(assignment.recipe.id, recipeCoverage);
    }

    for (const recipe of recipes) {
      const recipeCoverage = coverage.get(recipe.id);
      expect(recipeCoverage).toBeDefined();
      expect(recipeCoverage?.size).toBeGreaterThanOrEqual(1);
      expect(recipeCoverage?.size).toBeLessThanOrEqual(3);
    }
  });
});
