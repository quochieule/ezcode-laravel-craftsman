import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  readComposer,
  detectConventions,
  buildFingerprint,
} from '../lib/laravel/fingerprint.js';
import {
  checklistFor,
  renderChecklist,
  VERTICAL_CHAIN,
} from '../lib/laravel/blueprint.js';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, 'fixtures', 'laravel-app');

test('readComposer: version + packages', async () => {
  const c = await readComposer(appRoot);
  assert.equal(c.laravelVersion, '^11.0');
  assert.ok(c.packages.includes('laravel/sanctum'));
  assert.ok(c.packages.includes('spatie/laravel-activitylog'));
  assert.ok(c.devPackages.includes('pestphp/pest'));
});

test('detectConventions: FormRequest, Services, Policies, Pest, activity()', async () => {
  const c = await detectConventions(appRoot);
  assert.equal(c.validation, 'FormRequest');
  assert.equal(c.controllers.services, true);
  assert.equal(c.auth.policies, true);
  assert.equal(c.auth.sanctum, true);
  assert.equal(c.tests.framework, 'Pest');
  assert.ok(c.tests.files >= 1);
  assert.ok(c.logging['activity('] >= 1); // OrderController dùng activity()
  assert.ok(
    Array.isArray(c.frontend.jsFiles) &&
      c.frontend.jsFiles.includes('admin/orders.js'),
  );
  assert.equal(c.frontend.bladeLayouts, true);
});

test('buildFingerprint: artisan about fail (fixture không boot được) → about=null, không throw', async () => {
  const fp = await buildFingerprint(appRoot, {});
  assert.equal(fp.about, null);
  assert.equal(fp.composer.laravelVersion, '^11.0');
});

test('blueprint: checklist đủ 14 mắt xích + 8 loại feature', () => {
  assert.equal(VERTICAL_CHAIN.length, 14);
  assert.ok(Object.keys(checklistFor('api-endpoint').touchpoints).length >= 1);
  // fallback khi type không biết
  assert.ok(checklistFor('unknown-type').touchpoints.includes('route'));
  const rendered = renderChecklist('api-endpoint');
  assert.ok(rendered.includes('Route'));
  assert.ok(rendered.includes('Log'));
});
