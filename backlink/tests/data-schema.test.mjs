import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));

function errors(value, schema, root = schema, path = '$') {
  if (schema.$ref) {
    const resolved = schema.$ref.slice(2).split('/').reduce((part, key) => part[key], root);
    return errors(value, resolved, root, path);
  }
  const found = [];
  const fail = (reason) => found.push(`${path}: ${reason}`);
  const types = schema.type ? [schema.type].flat() : [];
  const matches = (type) => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value)
    : type === 'integer' ? Number.isInteger(value)
    : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
    : typeof value === type;
  if (types.length && !types.some(matches)) { fail(`type ${types.join('|')}`); return found; }
  if (schema.enum && !schema.enum.some((item) => Object.is(item, value))) fail('enum');
  if (typeof value === 'string') {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) fail('pattern');
    if (schema.minLength !== undefined && [...value].length < schema.minLength) fail('minLength');
    if (schema.format === 'uri' && !URL.canParse(value)) fail('uri');
    if (schema.format === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(value)) fail('date');
    if (schema.format === 'date-time' && Number.isNaN(Date.parse(value))) fail('date-time');
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) fail('minimum');
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) fail('minItems');
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) fail('uniqueItems');
    if (schema.items) value.forEach((item, i) => found.push(...errors(item, schema.items, root, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail(`required ${key}`);
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(schema.properties || {}, key)) found.push(...errors(item, schema.properties[key], root, `${path}.${key}`));
      else if (schema.additionalProperties === false) fail(`additionalProperties ${key}`);
    }
  }
  return found;
}

test('all backlink data matches its complete JSON schema', () => {
  for (const name of ['submission-targets', 'free-channels', 'index-submission']) {
    const data = read(`../data/${name}.json`);
    const schema = read(`../data/schema/${name}.schema.json`);
    assert.deepEqual(errors(data, schema), [], name);
  }
});
