// Canonical, dependency-free contract checks shared with the frontend.
// Keep lesson.schema.json aligned; backend tests exercise both validators.
const ROOT_KEYS = ['schemaVersion', 'catalogVersion', 'lessonType', 'title', 'audience', 'blocks', 'visual', 'presentation', 'sourceIds', 'assumptions'];
export const SOURCE_IDS = Object.freeze(['seiler-kjerland-2006']);
export const CLAIM_IDS = Object.freeze(['display-convention', 'fictional-inputs', 'three-zone-framework']);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sameKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/<\/?[a-z][^>]*>|javascript\s*:/i.test(value);
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const ids = (value, allowed, max) => Array.isArray(value) && value.length <= max && new Set(value).size === value.length && value.every((id) => allowed.includes(id));

/** Returns { valid, errors }. Never executes or coerces imported values. */
export function validateLesson(content) {
  const errors = [];
  if (!sameKeys(content, ROOT_KEYS)) return { valid: false, errors: ['Lesson fields are missing or unsupported.'] };
  if (content.schemaVersion !== 1 || content.catalogVersion !== 1) errors.push('This lesson or evidence version is not supported.');
  if (content.lessonType !== 'three-zone-explainer') errors.push('This lesson type is not supported.');
  if (!text(content.title, 120)) errors.push('Use a plain-text title between 1 and 120 characters.');
  if (!['beginner', 'intermediate'].includes(content.audience)) errors.push('Choose a supported audience.');
  if (!Array.isArray(content.blocks) || content.blocks.length < 1 || content.blocks.length > 6) errors.push('Include between one and six explanation paragraphs.');
  else for (const block of content.blocks) {
    if (!sameKeys(block, ['type', 'text', 'claimIds']) || block.type !== 'paragraph' || !text(block.text, 1200) || !ids(block.claimIds, CLAIM_IDS, 3)) errors.push('An explanation paragraph or its evidence references are invalid.');
  }
  const visual = content.visual;
  if (!sameKeys(visual, ['component', 'unit', 'domain', 'lt1', 'lt2', 'defaultPower'])) errors.push('The visual settings are incomplete or unsupported.');
  else {
    if (visual.component !== 'three-zone-power' || visual.unit !== 'W') errors.push('Use the supported cycling-power diagram in watts.');
    if (!sameKeys(visual.domain, ['min', 'max']) || visual.domain.min !== 0 || !finite(visual.domain.max) || visual.domain.max < 100 || visual.domain.max > 1000) errors.push('The power range must start at 0 and end between 100 and 1000 W.');
    if (![visual.lt1, visual.lt2, visual.defaultPower].every(finite)) errors.push('Power values must be finite numbers.');
    else if (isObject(visual.domain)) {
      if (!(visual.domain.min < visual.lt1 && visual.lt1 < visual.lt2 && visual.lt2 < visual.domain.max)) errors.push('Keep LT1 below LT2 and both thresholds inside the power range.');
      if (!(visual.defaultPower >= visual.domain.min && visual.defaultPower <= visual.domain.max)) errors.push('The starting power must be inside the power range.');
    }
  }
  if (!sameKeys(content.presentation, ['theme', 'accent']) || content.presentation.theme !== 'light' || !['teal', 'blue', 'amber'].includes(content.presentation.accent)) errors.push('Choose a supported visual style.');
  if (!ids(content.sourceIds, SOURCE_IDS, 1)) errors.push('A source reference is not in the evidence catalogue.');
  if (Array.isArray(content.blocks) && content.blocks.some((block) => Array.isArray(block?.claimIds) && block.claimIds.includes('three-zone-framework')) && !(Array.isArray(content.sourceIds) && content.sourceIds.includes('seiler-kjerland-2006'))) errors.push('The three-zone research claim requires its supporting source.');
  if (!Array.isArray(content.assumptions) || content.assumptions.length < 1 || content.assumptions.length > 6 || !content.assumptions.every((value) => text(value, 500))) errors.push('Include one to six plain-text assumptions.');
  return { valid: errors.length === 0, errors: [...new Set(errors)] };
}

/** Display convention: exact thresholds are in Z2 and separately labelled. */
export function classifyPower(power, lt1, lt2) {
  if (![power, lt1, lt2].every(finite) || !(lt1 > 0 && lt1 < lt2) || power < 0) throw new TypeError('Invalid power or thresholds.');
  const zone = power < lt1 ? 1 : power <= lt2 ? 2 : 3;
  return { zone, label: `Zone ${zone}`, boundary: power === lt1 ? 'At LT1' : power === lt2 ? 'At LT2' : null };
}
