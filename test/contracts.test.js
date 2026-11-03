import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { example, lessonSchema } from '../src/generation.js';
import { validateLesson, classifyPower } from '../contracts/validation.js';

const shape = new Ajv({ strict: true, allErrors: true }).compile(lessonSchema);

test('canonical fixture satisfies the schema and semantic checks', () => {
  assert.equal(shape(example), true, JSON.stringify(shape.errors));
  assert.deepEqual(validateLesson(example), { valid: true, errors: [] });
});

test('threshold equality is explicit and matches the teaching convention', () => {
  const inputs = [0, 179.9, 180, 200, 240, 240.1, 350];
  assert.deepEqual(inputs.map((p) => classifyPower(p, 180, 240).zone), [1, 1, 2, 2, 2, 3, 3]);
  assert.equal(classifyPower(180, 180, 240).boundary, 'At LT1');
  assert.equal(classifyPower(240, 180, 240).boundary, 'At LT2');
  assert.equal(classifyPower(200, 180, 240).boundary, null);
  assert.throws(() => classifyPower(NaN, 180, 240));
  assert.throws(() => classifyPower(200, 240, 180));
});

test('fractional thresholds near the domain maximum agree across validators', () => {
  const content = structuredClone(example);
  content.visual.domain.max = 1000;
  content.visual.lt1 = 999.1;
  content.visual.lt2 = 999.5;
  assert.equal(shape(content), true);
  assert.equal(validateLesson(content).valid, true);
});

test('schema rejects executable/identity fields and unsupported components', () => {
  for (const mutate of [
    (x) => { x.code = 'alert(1)'; },
    (x) => { x.reviewStatus = 'approved'; },
    (x) => { x.visual.component = 'custom-code'; },
    (x) => { x.visual.formula = 'eval(input)'; },
    (x) => { x.sourceIds = ['unverified-source']; }
  ]) {
    const content = structuredClone(example);
    mutate(content);
    assert.equal(shape(content), false);
    assert.equal(validateLesson(content).valid, false);
  }
});

test('semantic checks reject invalid inputs without coercion', () => {
  for (const mutate of [
    (x) => { x.visual.lt1 = x.visual.lt2; },
    (x) => { x.visual.lt2 = 100; },
    (x) => { x.visual.defaultPower = 999; },
    (x) => { x.visual.lt1 = Infinity; },
    (x) => { x.visual.lt1 = '180'; },
    (x) => { x.blocks[0].text = '<script>alert(1)</script>'; },
    (x) => { x.sourceIds = []; x.blocks[0].claimIds = ['three-zone-framework']; }
  ]) {
    const content = structuredClone(example);
    mutate(content);
    assert.equal(validateLesson(content).valid, false);
  }
});

test('malformed imports return errors instead of throwing', () => {
  for (const value of [null, [], '', 42, {}, { ...example, blocks: [null] }, { ...example, blocks: [{ type: 'paragraph', text: 'x', claimIds: { includes: 1 } }] }, { ...example, visual: null }, { ...example, presentation: null }, { ...example, sourceIds: null }]) {
    assert.doesNotThrow(() => validateLesson(value));
    assert.equal(validateLesson(value).valid, false);
  }
});
