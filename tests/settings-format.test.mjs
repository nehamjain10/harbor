// The pure parts of the settings editor: member-wise JSON edits, memory frontmatter and
// index lines, and what counts as a valid rule or hook.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { REMOVE, editJson } from '../server/json-edit.mjs';
import { addIndexLine, composeMemory, indexLine, memoryTitle, parseFrontmatter, parseIndex, removeIndexLines } from '../server/memory-format.mjs';
import { hookSummary, hooksProblem, permissionsProblem, permissionsView, ruleProblem, settingsProblem } from '../server/settings-schema.mjs';

describe('editJson', () => {
  // Odd on purpose: tabs, a compact object with extra spaces, a number in exponent form,
  // an escaped character and keys in no particular order.
  const odd = '{\n\t"zeta": {"a":   1,"b":2e3},\n\t"model": "opus",\n\t"name": "caf\\u00e9",\n\t"permissions": {\n\t\t"defaultMode": "auto",\n\t\t"deny": ["Bash(rm *)"]\n\t},\n\t"alpha": [1,2 , 3]\n}\n';

  test('changes only the member it is told to; everything else stays byte for byte', () => {
    const next = editJson(odd, [{ path: ['permissions', 'allow'], value: ['Bash(ls)', 'Read(~/x/**)'] }]);
    assert.equal(
      next,
      '{\n\t"zeta": {"a":   1,"b":2e3},\n\t"model": "opus",\n\t"name": "caf\\u00e9",\n\t"permissions": {\n\t\t"defaultMode": "auto",\n\t\t"deny": ["Bash(rm *)"],\n\t\t"allow": [\n\t\t\t"Bash(ls)",\n\t\t\t"Read(~/x/**)"\n\t\t]\n\t},\n\t"alpha": [1,2 , 3]\n}\n',
    );
    assert.deepEqual(Object.keys(JSON.parse(next)), ['zeta', 'model', 'name', 'permissions', 'alpha']);
  });

  test('replaces a value in place and removes members with their commas', () => {
    assert.equal(editJson(odd, [{ path: ['permissions', 'defaultMode'], value: 'plan' }]), odd.replace('"auto"', '"plan"'));
    const without = editJson(odd, [{ path: ['model'], value: REMOVE }]);
    assert.equal(without, odd.replace('\t"model": "opus",\n', ''));
    const last = editJson(odd, [{ path: ['alpha'], value: REMOVE }]);
    assert.equal(last, odd.replace('"alpha": [1,2 , 3]', '').replace('\t\n}', '}').replace('},\n}', '}\n}'));
    assert.deepEqual(JSON.parse(last), { zeta: { a: 1, b: 2000 }, model: 'opus', name: 'café', permissions: { defaultMode: 'auto', deny: ['Bash(rm *)'] } });
    assert.equal(editJson('{\n  "only": 1\n}\n', [{ path: ['only'], value: REMOVE }]), '{}\n');
    // Nothing to remove: the text is returned as it was.
    assert.equal(editJson(odd, [{ path: ['hooks'], value: REMOVE }, { path: ['permissions', 'ask'], value: REMOVE }]), odd);
  });

  test('adds a missing member at the end in the file\'s own indentation, creating parents', () => {
    const next = editJson('{\n    "a": 1\n}', [{ path: ['permissions', 'allow'], value: ['X'] }]);
    assert.equal(next, '{\n    "a": 1,\n    "permissions": {\n        "allow": [\n            "X"\n        ]\n    }\n}');
    assert.equal(editJson('{}\n', [{ path: ['hooks'], value: {} }]), '{\n  "hooks": {}\n}\n');
    // A member that is not an object is replaced by one.
    assert.deepEqual(JSON.parse(editJson('{\n  "permissions": null\n}', [{ path: ['permissions', 'allow'], value: ['X'] }])), { permissions: { allow: ['X'] } });
  });

  test('applies several edits in order', () => {
    const next = editJson('{\n  "a": 1\n}\n', [
      { path: ['permissions', 'allow'], value: ['A'] },
      { path: ['permissions', 'ask'], value: ['B'] },
      { path: ['a'], value: REMOVE },
    ]);
    assert.deepEqual(JSON.parse(next), { permissions: { allow: ['A'], ask: ['B'] } });
  });

  test('keeps CRLF line endings and a byte order mark', () => {
    const crlf = '\uFEFF{\r\n  "a": 1\r\n}\r\n';
    const next = editJson(crlf, [{ path: ['b'], value: { c: 1 } }]);
    assert.equal(next, '\uFEFF{\r\n  "a": 1,\r\n  "b": {\r\n    "c": 1\r\n  }\r\n}\r\n');
  });

  test('an object on one line is rewritten when one of its members changes; the rest of the file is not', () => {
    const mixed = '{\n  "env": {"A": "1"},\n  "permissions": {"defaultMode": "plan", "deny": ["Read"]},\n  "x": [1,2]\n}\n';
    assert.equal(
      editJson(mixed, [{ path: ['permissions', 'allow'], value: ['Bash'] }]),
      '{\n  "env": {"A": "1"},\n  "permissions": {\n    "defaultMode": "plan",\n    "deny": [\n      "Read"\n    ],\n    "allow": [\n      "Bash"\n    ]\n  },\n  "x": [1,2]\n}\n',
    );
    assert.equal(
      editJson(mixed, [{ path: ['permissions', 'defaultMode'], value: REMOVE }]),
      '{\n  "env": {"A": "1"},\n  "permissions": {\n    "deny": [\n      "Read"\n    ]\n  },\n  "x": [1,2]\n}\n',
    );
  });

  test('a one-line file is written back as plain 2-space JSON', () => {
    assert.equal(editJson('{"a":1}', [{ path: ['b'], value: 2 }]), '{\n  "a": 1,\n  "b": 2\n}');
    assert.equal(editJson('{"a":1,"b":2}\n', [{ path: ['a'], value: REMOVE }]), '{\n  "b": 2\n}\n');
  });

  test('refuses text that is not a JSON object', () => {
    assert.throws(() => editJson('[1]', []), /top level/);
    assert.throws(() => editJson('{', []), SyntaxError);
  });
});

describe('memory frontmatter', () => {
  const memory = '---\nname: workbench-v2\ndescription: "Harbor: a \\"workbench\\""\nmetadata: \n  node_type: memory\n  type: project\n  originSessionId: 409252af\n---\n\nBody line.\n';

  test('reads name, description, type (metadata.type or a top-level type) and the body', () => {
    const parsed = parseFrontmatter(memory);
    assert.equal(parsed.data.name, 'workbench-v2');
    assert.equal(parsed.data.description, 'Harbor: a "workbench"');
    assert.equal(parsed.type, 'project');
    assert.equal(parsed.body, '\nBody line.\n');
    assert.equal(parseFrontmatter('---\nname: x\ntype: feedback\n---\nbody').type, 'feedback');
    assert.deepEqual(parseFrontmatter('no frontmatter\n'), { data: {}, raw: null, body: 'no frontmatter\n', type: '' });
    assert.equal(parseFrontmatter("---\nname: 'it''s'\n---\n").data.name, "it's");
  });

  test('composeMemory sets fields and keeps every other line', () => {
    const next = composeMemory(memory, { name: 'workbench-v3', description: 'New: "text"', type: 'feedback', body: 'Changed.\n' });
    assert.equal(next, '---\nname: workbench-v3\ndescription: "New: \\"text\\""\nmetadata: \n  node_type: memory\n  type: feedback\n  originSessionId: 409252af\n---\nChanged.\n');
    // A body-only change leaves the frontmatter byte for byte.
    assert.equal(composeMemory(memory, { body: 'x' }), memory.replace('\nBody line.\n', 'x'));
    // Fields that are missing are added: name first, the type in a new metadata block.
    assert.equal(composeMemory('---\ndescription: "d"\n---\nb', { name: 'n', type: 'user' }), '---\nname: n\ndescription: "d"\nmetadata:\n  type: user\n---\nb');
    assert.equal(composeMemory('just text', { name: 'n', description: 'd' }), '---\nname: n\ndescription: "d"\n---\njust text');
  });

  test('titles fall back to the file name', () => {
    assert.equal(memoryTitle('a-note.md', { name: 'A note' }), 'A note');
    assert.equal(memoryTitle('a-note.md', {}), 'a-note');
  });
});

describe('memory index', () => {
  const index = '# Memory Index\n\n- [Release](release.md) — run lineage\n- [No hook](plain.md)\n\nNot a memory line.\n- [Dash](dash.md) - hyphen hook\n';

  test('parses `- [Title](file.md) — hook` lines', () => {
    assert.deepEqual(parseIndex(index), [
      { line: 2, title: 'Release', file: 'release.md', hook: 'run lineage' },
      { line: 3, title: 'No hook', file: 'plain.md', hook: '' },
      { line: 6, title: 'Dash', file: 'dash.md', hook: 'hyphen hook' },
    ]);
  });

  test('adds one line per file at the end, and starts an index when there is none', () => {
    assert.equal(indexLine({ title: 'A [b]', file: 'a.md', hook: 'one\ntwo  words' }), '- [A (b)](a.md) — one two words');
    assert.equal(indexLine({ title: '', file: 'a.md', hook: '' }), '- [a](a.md)');
    assert.equal(addIndexLine(index, { title: 'New', file: 'new.md', hook: 'h' }), index + '- [New](new.md) — h\n');
    assert.equal(addIndexLine(index, { title: 'Again', file: 'release.md', hook: 'x' }), index, 'a file already listed is not listed twice');
    assert.equal(addIndexLine('', { title: 'New', file: 'new.md', hook: 'h' }), '# Memory Index\n\n- [New](new.md) — h\n');
    assert.equal(addIndexLine('- [A](a.md)', { title: 'B', file: 'b.md' }), '- [A](a.md)\n- [B](b.md)\n');
  });

  test('removes every line that points at a file, and nothing else', () => {
    assert.equal(removeIndexLines(index, 'plain.md'), index.replace('- [No hook](plain.md)\n', ''));
    assert.equal(removeIndexLines(index, 'absent.md'), index);
    assert.equal(removeIndexLines('- [A](a.md)\n- [A again](a.md)\n- [B](b.md)\n', 'a.md'), '- [B](b.md)\n');
  });
});

describe('settings schema', () => {
  test('rule syntax: a tool name with an optional specifier', () => {
    for (const rule of ['Bash', 'Bash(npm run test:*)', 'Read(~/secrets/**)', 'mcp__server__tool', 'WebFetch(domain:example.com)', 'Edit(//tmp/**)', 'Bash(echo (hi))']) {
      assert.equal(ruleProblem(rule), null, rule);
    }
    for (const rule of ['', '  ', ' Bash', 'Bash(ls', 'two words', 'Bash(ls)\nBash(pwd)', 7, null, 'x'.repeat(1001)]) {
      assert.ok(ruleProblem(rule), String(rule));
    }
  });

  test('permissions: lists of rules, directories and a mode name; unknown keys are fine', () => {
    assert.equal(permissionsProblem(undefined), null);
    assert.equal(permissionsProblem({ allow: ['Bash'], deny: [], defaultMode: 'plan', additionalDirectories: ['/tmp/x'], disableBypassPermissionsMode: 'disable' }), null);
    assert.match(permissionsProblem({ allow: 'Bash' }), /permissions\.allow must be a list/);
    assert.match(permissionsProblem({ ask: ['ok', 'two words'] }), /permissions\.ask/);
    assert.match(permissionsProblem({ additionalDirectories: [3] }), /directory/);
    assert.match(permissionsProblem({ defaultMode: 'plan mode' }), /defaultMode/);
    assert.match(permissionsProblem([]), /must be an object/);
  });

  test('hooks: events of matcher groups of hooks', () => {
    const ok = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi', timeout: 5 }] }], Stop: [{ hooks: [{ type: 'prompt', prompt: 'p' }] }] };
    assert.equal(hooksProblem(ok), null);
    assert.equal(hooksProblem({}), null);
    assert.match(hooksProblem([]), /object keyed by event/);
    assert.match(hooksProblem({ Stop: {} }), /hooks\.Stop must be a list/);
    assert.match(hooksProblem({ Stop: [{ matcher: 1, hooks: [] }] }), /matcher must be text/);
    assert.match(hooksProblem({ Stop: [{}] }), /hooks\.Stop\[0\]\.hooks must be a list/);
    assert.match(hooksProblem({ Stop: [{ hooks: [{ command: 'x' }] }] }), /type must be text/);
    assert.match(hooksProblem({ Stop: [{ hooks: [{ type: 'command' }] }] }), /command must be the command to run/);
    assert.match(hooksProblem({ Stop: [{ hooks: [{ type: 'command', command: 'x', timeout: 0 }] }] }), /timeout/);
  });

  test('views: lists are always present; whole settings are checked part by part', () => {
    assert.deepEqual(permissionsView({ permissions: { allow: ['A', 3], defaultMode: 'plan' } }), { allow: ['A'], ask: [], deny: [], defaultMode: 'plan', additionalDirectories: [] });
    assert.equal(settingsProblem({ model: 'opus' }), null);
    assert.match(settingsProblem({ hooks: [] }), /hooks/);
    assert.match(settingsProblem([]), /JSON object/);
    assert.equal(hookSummary({ type: 'command', command: 'ls' }), 'ls');
    assert.equal(hookSummary({ type: 'mcp_tool', server: 'srv', tool: 't' }), 'srv:t');
  });
});
