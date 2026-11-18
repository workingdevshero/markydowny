// markychecky's hook script, run the way Claude Code runs it: hook JSON on stdin.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const plugin = path.join(root, 'plugins', 'markychecky');
const script = path.join(plugin, 'scripts', 'markychecky.py');
const hasPython = spawnSync('python3', ['--version']).status === 0;

function sandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'markychecky-'));
    return {
        dir,
        board: path.join(dir, 'board.md'),
        env: {
            ...process.env,
            CLAUDE_PLUGIN_DATA: path.join(dir, 'data'),
            MARKYCHECKY_FILE: path.join(dir, 'board.md'),
            MARKYCHECKY_OPEN: 'false',
        },
    };
}

function hook(box, command, event) {
    const result = spawnSync('python3', [script, command], {
        input: JSON.stringify({ cwd: box.dir, ...event }),
        env: box.env,
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'hooks print nothing, so nothing reaches the session');
    return result;
}

const create = (session, id, subject, activeForm = '') => ({
    session_id: session,
    tool_name: 'TaskCreate',
    tool_input: { subject, description: 'details', activeForm },
    tool_response: { task: { id: String(id), subject } },
});
const update = (session, id, input) => ({
    session_id: session,
    tool_name: 'TaskUpdate',
    tool_input: { taskId: String(id), ...input },
    tool_response: { success: true, taskId: String(id) },
});
const read = box => fs.readFileSync(box.board, 'utf8');
const section = (board, session) => {
    const m = board.match(new RegExp(`<!-- markychecky:start ${session} [^>]*-->\\n([\\s\\S]*?)<!-- markychecky:end ${session} -->`));
    assert.ok(m, `no section for ${session} in:\n${board}`);
    return m[1];
};

test('a session\'s tasks become its section: Now, then the checklist in task order', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('s1', 1, 'Write the docs', 'Writing the docs'));
    hook(box, 'task', create('s1', 2, 'Open the PR', 'Opening the PR'));
    hook(box, 'task', update('s1', 1, { status: 'in_progress' }));
    let s = section(read(box), 's1');
    assert.match(s, /\*\*Now:\*\* Writing the docs/);
    assert.match(s, /- \[ \] \*\*Write the docs\*\*\n- \[ \] Open the PR/);
    hook(box, 'task', update('s1', 1, { status: 'completed' }));
    hook(box, 'task', update('s1', 2, { status: 'completed' }));
    s = section(read(box), 's1');
    assert.match(s, /\*\*Now:\*\* all done/);
    assert.match(s, /- \[x\] Write the docs\n- \[x\] Open the PR/);
    assert.match(read(box), /^# Markychecky\n/);
});

test('sessions only ever replace their own section, and a person\'s notes are kept', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('a', 1, 'Task A'));
    hook(box, 'task', create('b', 1, 'Task B'));
    // A person adds notes between and after the sections.
    const withNotes = read(box).replace('<!-- markychecky:start b', 'My note between.\n\n<!-- markychecky:start b') + '\nMy note at the end.\n';
    fs.writeFileSync(box.board, withNotes);
    hook(box, 'task', update('a', 1, { status: 'completed' }));
    const board = read(box);
    assert.match(section(board, 'a'), /- \[x\] Task A/);
    assert.match(section(board, 'b'), /- \[ \] Task B/);
    assert.match(board, /My note between\.\n\n<!-- markychecky:start b/);
    assert.match(board, /My note at the end\.\n$/);
});

test('a renamed header still belongs to its session (sections are matched by a hidden marker)', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('s1', 1, 'First'));
    fs.writeFileSync(box.board, read(box).replace(/^## .*$/m, '## Renamed by hand'));
    hook(box, 'task', create('s1', 2, 'Second'));
    const board = read(box);
    assert.equal((board.match(/markychecky:start s1/g) || []).length, 1, 'one section, not two');
    assert.match(section(board, 's1'), /First\n- \[ \] Second/);
});

test('deleted tasks disappear, edited subjects update, and TodoWrite replaces the whole list', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('s1', 1, 'Keep'));
    hook(box, 'task', create('s1', 2, 'Drop'));
    hook(box, 'task', update('s1', 2, { status: 'deleted' }));
    hook(box, 'task', update('s1', 1, { subject: 'Keep, renamed' }));
    let s = section(read(box), 's1');
    assert.match(s, /Keep, renamed/);
    assert.doesNotMatch(s, /Drop/);
    hook(box, 'task', {
        session_id: 's2',
        tool_name: 'TodoWrite',
        tool_input: { todos: [
            { content: 'Old style one', status: 'completed', activeForm: 'Doing one' },
            { content: 'Old style two', status: 'in_progress', activeForm: 'Doing two' },
        ] },
    });
    s = section(read(box), 's2');
    assert.match(s, /\*\*Now:\*\* Doing two/);
    assert.match(s, /- \[x\] Old style one\n- \[ \] \*\*Old style two\*\*/);
});

test('task text stays on one line and unicode survives', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('s1', 1, 'Fix  the\nnewline — and émoji 🎉'));
    assert.match(section(read(box), 's1'), /- \[ \] Fix the newline — and émoji 🎉\n/);
});

test('ending a session marks it idle, and old idle sections are swept on the next write', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('old', 1, 'Old work'));
    hook(box, 'end', { session_id: 'old' });
    assert.match(section(read(box), 'old'), /\*\*Now:\*\* idle, the session ended at \d\d:\d\d/);
    // A session that never made tasks has no section to end.
    hook(box, 'end', { session_id: 'nothing' });
    assert.doesNotMatch(read(box), /markychecky:start nothing/);
    // Age the ended section past the limit; the next write by anyone removes it.
    fs.writeFileSync(box.board, read(box).replace(/ended=\S+/, 'ended=2000-01-01T00:00:00+00:00'));
    hook(box, 'task', create('new', 1, 'New work'));
    const board = read(box);
    assert.doesNotMatch(board, /markychecky:start old/);
    assert.match(section(board, 'new'), /New work/);
});

test('twenty sessions writing at once all keep their sections', { skip: !hasPython }, async () => {
    const box = sandbox();
    const run = (event) => new Promise((resolve, reject) => {
        const child = spawn('python3', [script, 'task'], { env: box.env });
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.stdin.end(JSON.stringify({ cwd: box.dir, ...event }));
    });
    await Promise.all(Array.from({ length: 20 }, (_, i) => run(create(`s${i}`, 1, `Task ${i}`))));
    const board = read(box);
    for (let i = 0; i < 20; i++) assert.match(section(board, `s${i}`), new RegExp(`Task ${i}\\n`));
    const leftovers = fs.readdirSync(box.dir).filter(f => f.startsWith('.board.md.'));
    assert.deepEqual(leftovers, [], 'no temporary files left next to the board');
});

test('one session\'s task tools firing at once keep every task', { skip: !hasPython }, async () => {
    const box = sandbox();
    const run = (event) => new Promise((resolve, reject) => {
        const child = spawn('python3', [script, 'task'], { env: box.env });
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.stdin.end(JSON.stringify({ cwd: box.dir, ...event }));
    });
    await Promise.all(Array.from({ length: 8 }, (_, i) => run(create('s1', i + 1, `Task ${i + 1}`))));
    await Promise.all(Array.from({ length: 8 }, (_, i) => run(update('s1', i + 1, { status: 'completed' }))));
    const s = section(read(box), 's1');
    for (let i = 1; i <= 8; i++) assert.match(s, new RegExp(`- \\[x\\] Task ${i}\\n`));
});

test('a session that cleared its list is still marked idle when it ends', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('s1', 1, 'Only task'));
    hook(box, 'task', update('s1', 1, { status: 'deleted' }));
    hook(box, 'end', { session_id: 's1' });
    assert.match(read(box), /markychecky:start s1 ended=\S+ -->/);
    assert.match(section(read(box), 's1'), /\*\*Now:\*\* idle/);
});

test('an end marker with no UTC offset doesn\'t stop the board updating', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('old', 1, 'Old work'));
    hook(box, 'end', { session_id: 'old' });
    fs.writeFileSync(box.board, read(box).replace(/ended=\S+/, 'ended=2000-01-01T00:00:00'));
    hook(box, 'task', create('new', 1, 'New work'));
    assert.match(section(read(box), 'new'), /New work/);
});

test('an idle_hours that isn\'t a number falls back to a day', { skip: !hasPython }, () => {
    const box = sandbox();
    box.env.MARKYCHECKY_IDLE_HOURS = '1 day';
    hook(box, 'task', create('s1', 1, 'Still written'));
    assert.match(section(read(box), 's1'), /Still written/);
});

test('task text can\'t end its section early with a copy of the marker', { skip: !hasPython }, () => {
    const box = sandbox();
    hook(box, 'task', create('s1', 1, 'Quote <!-- markychecky:end s1 --> trailing'));
    hook(box, 'task', create('s1', 2, 'Second'));
    const board = read(box);
    assert.equal((board.match(/<!-- markychecky:end s1 -->/g) || []).length, 1);
    assert.match(section(board, 's1'), /- \[ \] Quote &lt;!-- markychecky:end s1 --> trailing\n- \[ \] Second\n/);
});

test('a bad payload never fails the session', { skip: !hasPython }, () => {
    const box = sandbox();
    const result = spawnSync('python3', [script, 'task'], { input: 'not json', env: box.env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(fs.readFileSync(path.join(box.dir, 'data', 'markychecky.log'), 'utf8'), /task/);
});

test('the hooks run the script on task-tool updates and at session end', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const post = hooks.PostToolUse[0];
    assert.deepEqual(post.matcher.split('|').sort(), ['TaskCreate', 'TaskUpdate', 'TodoWrite']);
    assert.match(post.hooks[0].command, /markychecky\.py" task/);
    assert.match(hooks.SessionEnd[0].hooks[0].command, /markychecky\.py" end/);
    // Without python3 the hook does nothing rather than erroring.
    for (const h of [post.hooks[0], hooks.SessionEnd[0].hooks[0]]) assert.match(h.command, /\|\| true$/);
});

test('the marketplace lists the plugin, and the versions agree', () => {
    const market = JSON.parse(fs.readFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
    const manifest = JSON.parse(fs.readFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), 'utf8'));
    const entry = market.plugins.find(p => p.name === 'markychecky');
    assert.ok(entry);
    assert.equal(entry.source, './plugins/markychecky');
    assert.equal(manifest.name, 'markychecky');
    assert.deepEqual(Object.keys(manifest.userConfig).sort(), ['file', 'idle_hours', 'open']);
});

test('issue and PR references in task text become links into the session\'s GitHub repo', { skip: !hasPython }, () => {
    const box = sandbox();
    spawnSync('git', ['init', '-q', box.dir]);
    spawnSync('git', ['-C', box.dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
    hook(box, 'task', create('s1', 1, 'Merge #18, then widgets#19 and other-org/tools#5', 'Merging #18'));
    hook(box, 'task', update('s1', 1, { status: 'in_progress' }));
    const s = section(read(box), 's1');
    assert.match(s, /\*\*Now:\*\* Merging \[#18\]\(https:\/\/github\.com\/acme\/widgets\/issues\/18\)/);
    assert.match(s, /\[#18\]\(https:\/\/github\.com\/acme\/widgets\/issues\/18\)/);
    assert.match(s, /\[widgets#19\]\(https:\/\/github\.com\/acme\/widgets\/issues\/19\)/);
    assert.match(s, /\[other-org\/tools#5\]\(https:\/\/github\.com\/other-org\/tools\/issues\/5\)/);
});

test('a reference in parentheses links, but existing links and anchors are left alone', { skip: !hasPython }, () => {
    const box = sandbox();
    spawnSync('git', ['init', '-q', box.dir]);
    spawnSync('git', ['-C', box.dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    hook(box, 'task', create('s1', 1, 'Merge Open Recent (#36), see [#9](https://x) and [top](#12)'));
    const s = section(read(box), 's1');
    assert.match(s, /Merge Open Recent \(\[#36\]\(https:\/\/github\.com\/acme\/widgets\/issues\/36\)\)/);
    assert.match(s, /see \[#9\]\(https:\/\/x\) and \[top\]\(#12\)/);
});

test('references that can\'t be linked for sure stay plain text', { skip: !hasPython }, () => {
    const box = sandbox(); // not a git repo: no GitHub remote
    hook(box, 'task', create('s1', 1, 'See #7 and somerepo#8, issue#3, C# and [#9](https://x)'));
    const s = section(read(box), 's1');
    assert.match(s, /See #7 and somerepo#8, issue#3, C# and \[#9\]\(https:\/\/x\)/);
});

test('every place markychecky is documented says how to turn on the task list', () => {
    const docs = {
        'plugin README': path.join(plugin, 'README.md'),
        'README': path.join(root, 'README.md'),
        'docs page': path.join(root, 'docs', 'claude-code.md'),
    };
    for (const [name, file] of Object.entries(docs)) {
        const text = fs.readFileSync(file, 'utf8');
        assert.match(text, /CLAUDE_CODE_ENABLE_TODO_TOOLS/, `${name} doesn't mention CLAUDE_CODE_ENABLE_TODO_TOOLS`);
        assert.match(text, /claude plugin install markychecky --marketplace workingdevshero\/markydowny/, `${name} doesn't give the install command`);
    }
    // The README links to the docs page's markychecky section by its anchor.
    const html = fs.readFileSync(path.join(root, 'docs', 'claude-code', 'index.html'), 'utf8');
    assert.match(html, /id="watch-every-session-markychecky"/);
});
