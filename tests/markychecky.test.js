// markychecky's hook, run the way Claude Code runs it: hook JSON on stdin. The behaviour tests run
// against both engines, the Python script and the Markydowny app's `markychecky` mode (when a
// build of the app is around: MARKYDOWNY_BIN, or src-tauri/target/debug/markydowny), and must
// pass the same on each.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.join(__dirname, '..');
const plugin = path.join(root, 'plugins', 'markychecky');
const script = path.join(plugin, 'scripts', 'markychecky.py');
const launcher = path.join(plugin, 'scripts', 'markychecky.sh');
const hasPython = spawnSync('python3', ['--version']).status === 0;
const MARKER = 'markychecky-hook-engine-1';
const appBin = process.env.MARKYDOWNY_BIN
    ? path.resolve(process.env.MARKYDOWNY_BIN)
    : path.join(root, 'src-tauri', 'target', 'debug', 'markydowny');
// A build from before the mode would open its window rather than run the hook.
const hasApp = fs.existsSync(appBin) && spawnSync('grep', ['-q', '-F', MARKER, appBin]).status === 0;
if (process.env.MARKYDOWNY_BIN && !hasApp) throw new Error(`MARKYDOWNY_BIN (${appBin}) has no markychecky mode`);

const engines = [
    { name: 'python', skip: !hasPython, argv: command => ['python3', [script, command]] },
    { name: 'app', skip: !hasApp, argv: command => [appBin, ['markychecky', command]] },
];

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

function run(engine, box, command, input) {
    const [cmd, args] = engine.argv(command);
    return spawnSync(cmd, args, { input, env: box.env, encoding: 'utf8' });
}

function hook(engine, box, command, event) {
    const result = run(engine, box, command, JSON.stringify({ cwd: box.dir, ...event }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, '', 'hooks print nothing, so nothing reaches the session');
    return result;
}

function hookAsync(engine, box, command, event) {
    return new Promise((resolve, reject) => {
        const [cmd, args] = engine.argv(command);
        const child = spawn(cmd, args, { env: box.env });
        child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`exit ${code}`))));
        child.stdin.end(JSON.stringify({ cwd: box.dir, ...event }));
    });
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

for (const engine of engines) {
    test(`[${engine.name}] a session's tasks become its section: Now, then the checklist in task order`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('s1', 1, 'Write the docs', 'Writing the docs'));
        hook(engine, box, 'task', create('s1', 2, 'Open the PR', 'Opening the PR'));
        hook(engine, box, 'task', update('s1', 1, { status: 'in_progress' }));
        let s = section(read(box), 's1');
        assert.match(s, /\*\*Now:\*\* Writing the docs/);
        assert.match(s, /- \[ \] \*\*Write the docs\*\*\n- \[ \] Open the PR/);
        hook(engine, box, 'task', update('s1', 1, { status: 'completed' }));
        hook(engine, box, 'task', update('s1', 2, { status: 'completed' }));
        s = section(read(box), 's1');
        assert.match(s, /\*\*Now:\*\* all done/);
        assert.match(s, /- \[x\] Write the docs\n- \[x\] Open the PR/);
        assert.match(read(box), /^# Markychecky\n/);
    });

    test(`[${engine.name}] sessions only ever replace their own section, and a person's notes are kept`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('a', 1, 'Task A'));
        hook(engine, box, 'task', create('b', 1, 'Task B'));
        // A person adds notes between and after the sections.
        const withNotes = read(box).replace('<!-- markychecky:start b', 'My note between.\n\n<!-- markychecky:start b') + '\nMy note at the end.\n';
        fs.writeFileSync(box.board, withNotes);
        hook(engine, box, 'task', update('a', 1, { status: 'completed' }));
        const board = read(box);
        assert.match(section(board, 'a'), /- \[x\] Task A/);
        assert.match(section(board, 'b'), /- \[ \] Task B/);
        assert.match(board, /My note between\.\n\n<!-- markychecky:start b/);
        assert.match(board, /My note at the end\.\n$/);
    });

    test(`[${engine.name}] a renamed header still belongs to its session (sections are matched by a hidden marker)`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('s1', 1, 'First'));
        fs.writeFileSync(box.board, read(box).replace(/^## .*$/m, '## Renamed by hand'));
        hook(engine, box, 'task', create('s1', 2, 'Second'));
        const board = read(box);
        assert.equal((board.match(/markychecky:start s1/g) || []).length, 1, 'one section, not two');
        assert.match(section(board, 's1'), /First\n- \[ \] Second/);
    });

    test(`[${engine.name}] deleted tasks disappear, edited subjects update, and TodoWrite replaces the whole list`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('s1', 1, 'Keep'));
        hook(engine, box, 'task', create('s1', 2, 'Drop'));
        hook(engine, box, 'task', update('s1', 2, { status: 'deleted' }));
        hook(engine, box, 'task', update('s1', 1, { subject: 'Keep, renamed' }));
        let s = section(read(box), 's1');
        assert.match(s, /Keep, renamed/);
        assert.doesNotMatch(s, /Drop/);
        hook(engine, box, 'task', {
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

    test(`[${engine.name}] task text stays on one line and unicode survives`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('s1', 1, 'Fix  the\nnewline — and émoji 🎉'));
        assert.match(section(read(box), 's1'), /- \[ \] Fix the newline — and émoji 🎉\n/);
    });

    test(`[${engine.name}] ending a session marks it idle, and old idle sections are swept on the next write`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('old', 1, 'Old work'));
        hook(engine, box, 'end', { session_id: 'old' });
        assert.match(section(read(box), 'old'), /\*\*Now:\*\* idle, the session ended at \d\d:\d\d/);
        // A session that never made tasks has no section to end.
        hook(engine, box, 'end', { session_id: 'nothing' });
        assert.doesNotMatch(read(box), /markychecky:start nothing/);
        // Age the ended section past the limit; the next write by anyone removes it.
        fs.writeFileSync(box.board, read(box).replace(/ended=\S+/, 'ended=2000-01-01T00:00:00+00:00'));
        hook(engine, box, 'task', create('new', 1, 'New work'));
        const board = read(box);
        assert.doesNotMatch(board, /markychecky:start old/);
        assert.match(section(board, 'new'), /New work/);
    });

    test(`[${engine.name}] twenty sessions writing at once all keep their sections`, { skip: engine.skip }, async () => {
        const box = sandbox();
        const run = event => hookAsync(engine, box, 'task', event);
        await Promise.all(Array.from({ length: 20 }, (_, i) => run(create(`s${i}`, 1, `Task ${i}`))));
        const board = read(box);
        for (let i = 0; i < 20; i++) assert.match(section(board, `s${i}`), new RegExp(`Task ${i}\\n`));
        const leftovers = fs.readdirSync(box.dir).filter(f => f.startsWith('.board.md.'));
        assert.deepEqual(leftovers, [], 'no temporary files left next to the board');
    });

    test(`[${engine.name}] one session's task tools firing at once keep every task`, { skip: engine.skip }, async () => {
        const box = sandbox();
        const run = event => hookAsync(engine, box, 'task', event);
        await Promise.all(Array.from({ length: 8 }, (_, i) => run(create('s1', i + 1, `Task ${i + 1}`))));
        await Promise.all(Array.from({ length: 8 }, (_, i) => run(update('s1', i + 1, { status: 'completed' }))));
        const s = section(read(box), 's1');
        for (let i = 1; i <= 8; i++) assert.match(s, new RegExp(`- \\[x\\] Task ${i}\\n`));
    });

    test(`[${engine.name}] a session that cleared its list is still marked idle when it ends`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('s1', 1, 'Only task'));
        hook(engine, box, 'task', update('s1', 1, { status: 'deleted' }));
        hook(engine, box, 'end', { session_id: 's1' });
        assert.match(read(box), /markychecky:start s1 ended=\S+ -->/);
        assert.match(section(read(box), 's1'), /\*\*Now:\*\* idle/);
    });

    test(`[${engine.name}] an end marker with no UTC offset doesn't stop the board updating`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('old', 1, 'Old work'));
        hook(engine, box, 'end', { session_id: 'old' });
        fs.writeFileSync(box.board, read(box).replace(/ended=\S+/, 'ended=2000-01-01T00:00:00'));
        hook(engine, box, 'task', create('new', 1, 'New work'));
        assert.match(section(read(box), 'new'), /New work/);
    });

    test(`[${engine.name}] an idle_hours that isn't a number falls back to a day`, { skip: engine.skip }, () => {
        const box = sandbox();
        box.env.MARKYCHECKY_IDLE_HOURS = '1 day';
        hook(engine, box, 'task', create('s1', 1, 'Still written'));
        assert.match(section(read(box), 's1'), /Still written/);
    });

    test(`[${engine.name}] task text can't end its section early with a copy of the marker`, { skip: engine.skip }, () => {
        const box = sandbox();
        hook(engine, box, 'task', create('s1', 1, 'Quote <!-- markychecky:end s1 --> trailing'));
        hook(engine, box, 'task', create('s1', 2, 'Second'));
        const board = read(box);
        assert.equal((board.match(/<!-- markychecky:end s1 -->/g) || []).length, 1);
        assert.match(section(board, 's1'), /- \[ \] Quote &lt;!-- markychecky:end s1 --> trailing\n- \[ \] Second\n/);
    });

    test(`[${engine.name}] a bad payload never fails the session`, { skip: engine.skip }, () => {
        const box = sandbox();
        const result = run(engine, box, 'task', 'not json');
        assert.equal(result.status, 0);
        assert.equal(result.stdout, '');
        assert.match(fs.readFileSync(path.join(box.dir, 'data', 'markychecky.log'), 'utf8'), /task/);
    });

    test(`[${engine.name}] issue and PR references in task text become links into the session's GitHub repo`, { skip: engine.skip }, () => {
        const box = sandbox();
        spawnSync('git', ['init', '-q', box.dir]);
        spawnSync('git', ['-C', box.dir, 'remote', 'add', 'origin', 'git@github.com:acme/widgets.git']);
        hook(engine, box, 'task', create('s1', 1, 'Merge #18, then widgets#19 and other-org/tools#5', 'Merging #18'));
        hook(engine, box, 'task', update('s1', 1, { status: 'in_progress' }));
        const s = section(read(box), 's1');
        assert.match(s, /\*\*Now:\*\* Merging \[#18\]\(https:\/\/github\.com\/acme\/widgets\/issues\/18\)/);
        assert.match(s, /\[#18\]\(https:\/\/github\.com\/acme\/widgets\/issues\/18\)/);
        assert.match(s, /\[widgets#19\]\(https:\/\/github\.com\/acme\/widgets\/issues\/19\)/);
        assert.match(s, /\[other-org\/tools#5\]\(https:\/\/github\.com\/other-org\/tools\/issues\/5\)/);
    });

    test(`[${engine.name}] a reference in parentheses links, but existing links and anchors are left alone`, { skip: engine.skip }, () => {
        const box = sandbox();
        spawnSync('git', ['init', '-q', box.dir]);
        spawnSync('git', ['-C', box.dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
        hook(engine, box, 'task', create('s1', 1, 'Merge Open Recent (#36), see [#9](https://x) and [top](#12)'));
        const s = section(read(box), 's1');
        assert.match(s, /Merge Open Recent \(\[#36\]\(https:\/\/github\.com\/acme\/widgets\/issues\/36\)\)/);
        assert.match(s, /see \[#9\]\(https:\/\/x\) and \[top\]\(#12\)/);
    });

    test(`[${engine.name}] a reference inside a link's text or a code span is left alone`, { skip: engine.skip }, () => {
        const box = sandbox();
        spawnSync('git', ['init', '-q', box.dir]);
        spawnSync('git', ['-C', box.dir, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
        hook(engine, box, 'task', create('s1', 1, 'Ship [Open Recent (#36)](https://github.com/acme/widgets/pull/36), [fix (widgets#19)](https://example.com) and `fixes (#40)`'));
        const s = section(read(box), 's1');
        assert.match(s, /Ship \[Open Recent \(#36\)\]\(https:\/\/github\.com\/acme\/widgets\/pull\/36\), \[fix \(widgets#19\)\]\(https:\/\/example\.com\) and `fixes \(#40\)`/);
    });

    test(`[${engine.name}] references that can't be linked for sure stay plain text`, { skip: engine.skip }, () => {
        const box = sandbox(); // not a git repo: no GitHub remote
        hook(engine, box, 'task', create('s1', 1, 'See #7 and somerepo#8, issue#3, C# and [#9](https://x)'));
        const s = section(read(box), 's1');
        assert.match(s, /See #7 and somerepo#8, issue#3, C# and \[#9\]\(https:\/\/x\)/);
    });

    test(`[${engine.name}] a write keeps the board's mode, and reads a CRLF board`, { skip: engine.skip }, () => {
        const box = sandbox();
        fs.writeFileSync(box.board, '# Mine\r\n\r\nA note.\r\n');
        fs.chmodSync(box.board, 0o600);
        hook(engine, box, 'task', create('s1', 1, 'Task'));
        assert.equal(fs.statSync(box.board).mode & 0o777, 0o600);
        assert.match(read(box), /^# Mine\n\nA note\.\n\n<!-- markychecky:start s1 -->/);
    });

    test(`[${engine.name}] a session in a git worktree is named after the repository, not the worktree folder`, { skip: engine.skip }, () => {
        const box = sandbox();
        const repo = path.join(box.dir, 'widgets');
        const tree = path.join(box.dir, 'wt-fix-login');
        const g = (...args) => assert.equal(spawnSync('git', args, { encoding: 'utf8' }).status, 0, args.join(' '));
        g('init', '-q', '-b', 'main', repo);
        g('-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
        g('-C', repo, 'worktree', 'add', '-q', '-b', 'fix/login', tree);
        hook(engine, box, 'task', { ...create('s1', 1, 'Fix the login'), cwd: tree });
        hook(engine, box, 'task', { ...create('s2', 1, 'Plan the release'), cwd: repo });
        assert.match(section(read(box), 's1'), /^## widgets · fix\/login$/m);
        assert.match(section(read(box), 's2'), /^## widgets · main$/m);
    });
}

test('the hooks run the script on task-tool updates and at session end', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(plugin, 'hooks', 'hooks.json'), 'utf8')).hooks;
    const post = hooks.PostToolUse[0];
    assert.deepEqual(post.matcher.split('|').sort(), ['TaskCreate', 'TaskUpdate', 'TodoWrite']);
    assert.match(post.hooks[0].command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/markychecky\.sh" task/);
    assert.match(hooks.SessionEnd[0].hooks[0].command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/markychecky\.sh" end/);
    // Not after compacting: that's the same session, which has been told already.
    assert.deepEqual(hooks.SessionStart[0].matcher.split('|').sort(), ['clear', 'resume', 'startup']);
    assert.match(hooks.SessionStart[0].hooks[0].command, /^sh "\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/session-start\.sh"/);
    // The launcher always exits 0; even so, a hook never fails the session.
    for (const h of [post.hooks[0], hooks.SessionEnd[0].hooks[0], hooks.SessionStart[0].hooks[0]]) assert.match(h.command, /\|\| true$/);
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

test('every place markychecky is documented says how to turn on the task list', () => {
    const docs = {
        'plugin README': path.join(plugin, 'README.md'),
        'README': path.join(root, 'README.md'),
        'Watching Claude Code page': path.join(root, 'docs', 'claude-code.md'),
        'markychecky page': path.join(root, 'docs', 'markychecky.md'),
    };
    for (const [name, file] of Object.entries(docs)) {
        const text = fs.readFileSync(file, 'utf8');
        assert.match(text, /CLAUDE_CODE_ENABLE_TODO_TOOLS/, `${name} doesn't mention CLAUDE_CODE_ENABLE_TODO_TOOLS`);
        assert.match(text, /claude plugin install markychecky --marketplace workingdevshero\/markydowny/, `${name} doesn't give the install command`);
    }
    // The markychecky page is published, and the README, the plugin README and the homepage link to it.
    assert.ok(fs.existsSync(path.join(root, 'docs', 'markychecky', 'index.html')));
    for (const file of [path.join(root, 'README.md'), path.join(plugin, 'README.md'), path.join(root, 'index.html')]) {
        assert.match(fs.readFileSync(file, 'utf8'), /markydowny\.com\/docs\/markychecky\/|href="\/docs\/markychecky\/"/, `${file} doesn't link to the markychecky page`);
    }
});

test('the markychecky page has every setup step an agent needs, each with a check', { skip: !hasPython }, () => {
    const page = fs.readFileSync(path.join(root, 'docs', 'markychecky.md'), 'utf8');
    for (const step of ['#### 1. Check what you need', '#### 2. Install the plugin', '#### 3. Turn on the task list', '#### 4. Start your sessions', '#### 5. Watch the board']) {
        assert.ok(page.includes(step), `missing "${step}"`);
    }
    // Steps 2 to 4 each end with a way to check them.
    assert.equal((page.match(/^\*\*Check:\*\*/gm) || []).length, 3);
    // The settings snippet in the page actually merges the setting into an existing file.
    const snippet = page.match(/```bash\npython3 - <<'EOF'\n([\s\S]*?)\nEOF\n```/);
    assert.ok(snippet, 'the settings snippet is missing');
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-home-'));
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'opus', env: { FOO: 'bar' } }));
    const run = spawnSync('python3', ['-'], { input: snippet[1], env: { ...process.env, HOME: home }, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const settings = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
    assert.deepEqual(settings, { model: 'opus', env: { FOO: 'bar', CLAUDE_CODE_ENABLE_TODO_TOOLS: '1' } });
});

// Both engines write the same board for the same events, byte for byte.
const both = { skip: !(hasPython && hasApp) };

/** A GitHub repository folder, for the heading and the links. */
function githubRepo(box) {
    const repo = path.join(box.dir, 'widgets');
    spawnSync('git', ['init', '-q', '-b', 'main', repo]);
    spawnSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/acme/widgets.git']);
    return repo;
}

/** Task text made to trip the hand-written matchers: code spans, links, refs, markers, spaces. */
function corpus() {
    const pieces = ['#', '#1', '#12', '`', '``', '[', ']', '(', ')', '!', '/', 'a', 'widgets', 'acme', 'Widgets',
        '-', '.', '_', '1', ' ', '  ', '\t', '\n', '\u00a0', '\u001f', 'é', '١', '<!--', '-->', 'x#3', 'C#', '](#4)',
        '[#5](u)', '`#6`', 'o/r#7', 'acme/#8', '#9]', '#10x', '<!-- markychecky:end s1 -->',
        '#١', '١٢', '#１', '²', '#²'];
    let seed = 54;
    const random = n => (seed = (seed * 1103515245 + 12345) % 2147483648) % n;
    const texts = ['Merge #18, then widgets#19 and other-org/tools#5', 'Ship [Open Recent (#36)](https://x/36) and `fixes (#40)`',
        '``a` #1 `b``', '![img](a(#2)b) #3', '[a [b] #4](c) #5', '[x][#6] #7', 'issue#3 (#4) -#5 /#6 [#7 .#8',
        '(#١) widgets#1١ #١٢ #１ #²', ''];
    for (let i = 0; i < 400; i++) texts.push(Array.from({ length: 1 + random(8) }, () => pieces[random(pieces.length)]).join(''));
    return texts;
}

test('both engines write byte-identical boards for the same events', both, () => {
    const boards = engines.map(engine => {
        const box = sandbox();
        box.env.TZ = 'UTC';
        const cwd = githubRepo(box);
        const todos = corpus().map((content, i) => ({ content, activeForm: `Doing ${content}`, status: ['pending', 'in_progress', 'completed', 'odd'][i % 4] }));
        fs.writeFileSync(box.board, 'Notes before.\r\n\r\n');
        hook(engine, box, 'task', { session_id: 'old', cwd, ...create('old', 1, 'Old work') });
        hook(engine, box, 'end', { session_id: 'old' });
        hook(engine, box, 'task', { session_id: 'old2', cwd, ...create('old2', 1, 'Older work') });
        hook(engine, box, 'end', { session_id: 'old2' });
        // Both long over: one in the engines' own form, one with an hour-only offset.
        const stamps = ['ended=2000-01-01T00:00:00.5+01:00', 'ended=2000-01-01T00+00'];
        fs.writeFileSync(box.board, read(box).replace(/ended=\S+/g, () => stamps.shift()));
        hook(engine, box, 'task', { session_id: 's1', cwd, tool_name: 'TodoWrite', tool_input: { todos } });
        hook(engine, box, 'task', { cwd, ...create('s2', 7, 'Seven (#7)', 'Making #7') });
        hook(engine, box, 'task', { cwd, ...create('s2', 10, 'Ten') });
        hook(engine, box, 'task', { cwd, ...create('s2', 'x', 'Named') });
        hook(engine, box, 'task', { cwd, ...create('s2', '١', 'Arabic one') });
        hook(engine, box, 'task', { cwd, ...update('s2', 7, { status: 'in_progress', subject: 'Seven, renamed' }) });
        hook(engine, box, 'task', { cwd, ...update('s2', 10, { status: 'deleted' }) });
        hook(engine, box, 'task', { cwd, session_id: 's 3/é!', tool_name: 'TaskCreate', tool_input: { subject: 42 }, tool_response: {} });
        hook(engine, box, 'end', { session_id: 's2' });
        // The end time differs between runs, not between engines.
        return read(box).replace(/ended=\S+/g, 'ended=T').replace(/ended at \d\d:\d\d/g, 'ended at HH:MM');
    });
    assert.ok(!boards[0].includes('markychecky:start old'), 'the old sections were swept');
    assert.ok(boards[0].indexOf('Arabic one') < boards[0].indexOf('Seven'), '١ sorts as 1');
    assert.equal(boards[1], boards[0]);
});

test('a session can switch engines mid-way: they share their state and the lock', both, async () => {
    const box = sandbox();
    const [python, app] = engines;
    hook(python, box, 'task', create('s1', 1, 'One'));
    hook(app, box, 'task', create('s1', 2, 'Two'));
    hook(python, box, 'task', update('s1', 1, { status: 'completed' }));
    hook(app, box, 'task', update('s1', 2, { status: 'in_progress' }));
    let s = section(read(box), 's1');
    assert.match(s, /\*\*Now:\*\* Two\n\n- \[x\] One\n- \[ \] \*\*Two\*\*\n/);
    hook(python, box, 'end', { session_id: 's1' });
    assert.match(section(read(box), 's1'), /\*\*Now:\*\* idle/);
    // Both at once, through the same lock file.
    await Promise.all(Array.from({ length: 16 }, (_, i) => hookAsync(engines[i % 2], box, 'task', create('s2', i + 1, `Task ${i + 1}`))));
    s = section(read(box), 's2');
    for (let i = 1; i <= 16; i++) assert.match(s, new RegExp(`- \\[ \\] Task ${i}\\n`));
});

test('the app\'s markychecky mode runs without starting the app: one call takes well under a second', { skip: !hasApp }, () => {
    const box = sandbox();
    const engine = engines[1];
    hook(engine, box, 'task', create('s1', 1, 'Warm up'));
    const started = process.hrtime.bigint();
    hook(engine, box, 'task', create('s1', 2, 'Timed'));
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.ok(ms < 1000, `one call took ${ms} ms`);
    assert.match(section(read(box), 's1'), /Timed/);
});

// The launcher, with a fake PATH and HOME: which engine it picks.
function launcherBox({ tools = [], darwin = false } = {}) {
    const box = sandbox();
    const bin = path.join(box.dir, 'bin');
    const home = path.join(box.dir, 'home');
    fs.mkdirSync(bin);
    fs.mkdirSync(home);
    // What the launcher needs, and cat for the fakes.
    for (const tool of ['grep', 'mkdir', 'cat']) {
        const real = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
        fs.symlinkSync(real, path.join(bin, tool));
    }
    const calls = path.join(box.dir, 'calls');
    // A fake engine records what it was run as, and its stdin.
    const fake = (file, name, marker = '') => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `#!/bin/sh\n# ${marker}\nprintf '%s %s\\n' ${name} "$*" >> "${calls}"\ncat >> "${calls}"\n`, { mode: 0o755 });
    };
    const tool = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    tool('uname', `echo ${darwin ? 'Darwin' : 'Linux'}`);
    const env = { CLAUDE_PLUGIN_DATA: path.join(box.dir, 'data'), PATH: bin, HOME: home };
    const launch = command => {
        const result = spawnSync('/bin/sh', [launcher, command], { input: '{"session_id":"s1"}', env, encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        return { stdout: result.stdout, calls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '' };
    };
    return { box, bin, home, env, fake, tool, launch };
}

const installedApp = fs.existsSync('/Applications/Markydowny.app/Contents/MacOS/markydowny');

test('the launcher prefers the Markydowny app, then markydowny on PATH, then Python', { skip: installedApp }, () => {
    const l = launcherBox();
    l.fake(path.join(l.bin, 'python3'), 'python');
    assert.equal(l.launch('task').calls, `python ${script} task\n{"session_id":"s1"}`);
    fs.rmSync(path.join(l.box.dir, 'calls'));
    l.fake(path.join(l.bin, 'markydowny'), 'path-app', MARKER);
    assert.equal(l.launch('end').calls, 'path-app markychecky end\n{"session_id":"s1"}');
    fs.rmSync(path.join(l.box.dir, 'calls'));
    l.fake(path.join(l.home, 'Applications', 'Markydowny.app', 'Contents', 'MacOS', 'markydowny'), 'mac-app', MARKER);
    const { stdout, calls } = l.launch('task');
    assert.equal(calls, 'mac-app markychecky task\n{"session_id":"s1"}');
    assert.equal(stdout, '');
});

test('the launcher skips a Markydowny without the mode, and uses an AppImage the installer saved', { skip: installedApp }, () => {
    const l = launcherBox();
    l.fake(path.join(l.bin, 'python3'), 'python');
    l.fake(path.join(l.bin, 'markydowny'), 'old-app'); // no marker: it would open its window
    assert.match(l.launch('task').calls, /^python /);
    fs.rmSync(path.join(l.box.dir, 'calls'));
    const appImage = path.join(l.box.dir, 'Markydowny.AppImage');
    l.fake(appImage, 'appimage');
    fs.mkdirSync(l.env.CLAUDE_PLUGIN_DATA, { recursive: true });
    fs.writeFileSync(path.join(l.env.CLAUDE_PLUGIN_DATA, 'markydowny-path'), `${appImage}\n`);
    assert.equal(l.launch('task').calls, 'appimage markychecky task\n{"session_id":"s1"}');
});

test('the launcher uses an AppImage that saved itself, even without a trailing newline', { skip: installedApp }, () => {
    const l = launcherBox();
    l.fake(path.join(l.bin, 'python3'), 'python');
    const appImage = path.join(l.box.dir, 'Markydowny.AppImage');
    l.fake(appImage, 'appimage');
    const cache = path.join(l.home, '.cache', 'markychecky');
    fs.mkdirSync(cache, { recursive: true });
    fs.writeFileSync(path.join(cache, 'markydowny-path'), appImage);
    assert.equal(l.launch('end').calls, 'appimage markychecky end\n{"session_id":"s1"}');
    // One that has since been deleted is passed over.
    fs.rmSync(path.join(l.box.dir, 'calls'));
    fs.rmSync(appImage);
    assert.match(l.launch('end').calls, /^python /);
});


test('on a Mac, the launcher skips the python3 stub when the Command Line Tools aren\'t installed', () => {
    const l = launcherBox({ darwin: true });
    l.fake(path.join(l.bin, 'python3'), 'python');
    l.env.MARKYCHECKY_PYTHON_STUB = path.join(l.bin, 'python3');
    l.tool('xcode-select', 'exit 2');
    let { stdout, calls } = l.launch('task');
    assert.equal(calls, '', 'the stub never ran');
    assert.match(JSON.parse(stdout).systemMessage, /Markydowny/);
    // With the tools installed, the same python3 is a real Python.
    l.tool('xcode-select', 'echo /Library/Developer/CommandLineTools');
    ({ calls } = l.launch('task'));
    assert.match(calls, /^python /);
    // A python3 somewhere else (Homebrew, say) is real either way.
    l.tool('xcode-select', 'exit 2');
    l.env.MARKYCHECKY_PYTHON_STUB = '/usr/bin/python3';
    fs.rmSync(path.join(l.box.dir, 'calls'));
    ({ calls } = l.launch('end'));
    assert.match(calls, /^python .* end\n/);
});

test('with neither Markydowny nor Python, the launcher shows how to set up once, and exits 0', () => {
    const l = launcherBox();
    const first = l.launch('task');
    const hint = JSON.parse(first.stdout).systemMessage;
    assert.match(hint, /Markydowny/);
    assert.match(hint, /https:\/\/markydowny\.com\/docs\/install\//);
    assert.match(hint, /Python 3/);
    assert.equal(l.launch('task').stdout, '', 'only once');
    assert.equal(l.launch('end').stdout, '');
});
