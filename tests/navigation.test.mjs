import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import test from 'node:test';
import { primaryNavigation, navigationSections, navigationForPath } from '../src/lib/navigation.ts';

test('primary navigation is limited to everyday customer tasks', () => {
  assert.deepEqual(primaryNavigation.map(item => item.label), ['Marketplace', 'Swap', 'Portfolio', 'Create']);
  assert(!primaryNavigation.some(item => ['/team', '/protocol', '/assets'].includes(item.href)));
});

test('every menu destination exists and belongs to only one section', () => {
  const paths = Object.values(navigationSections).flatMap(section => section.items.map(item => item.href));
  assert.equal(new Set(paths).size, paths.length);
  for (const href of [...paths, ...primaryNavigation.map(item => item.href)]) {
    assert(existsSync(new URL(`../src/app${href}/page.tsx`, import.meta.url)), href);
  }
});

test('nested customer and operator routes retain the correct navigation context', () => {
  for (const [sectionName, section] of Object.entries(navigationSections)) {
    for (const item of section.items) {
      const actual = navigationForPath(item.href + '/');
      assert.equal(actual.section, section, sectionName + item.href);
      assert.equal(actual.primary, section.primary);
      assert.equal(actual.path, item.href);
    }
  }
  assert.equal(navigationForPath('/wallet').primary, '/my-assets');
  assert.equal(navigationForPath('/team/recovery').primary, null);
  assert.equal(navigationForPath('/fractionalize').primary, '/mint');
});

test('legacy URLs point at their real workflow and unknown paths do not claim a section', () => {
  for (const [before, after] of [['/', '/marketplace'], ['/list', '/my-assets'], ['/liquidate', '/my-assets'], ['/reserves', '/portfolio/reserves']]) {
    assert.equal(navigationForPath(before).path, after);
  }
  assert.equal(navigationForPath('/teamwork').section, null);
  assert.equal(navigationForPath('/assets').primary, null);
});
