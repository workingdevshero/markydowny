# markydowny

## Notes from the fleet

Written by the fleet's agents while addressing review feedback. No person has reviewed these lines: treat each as a suggestion to weigh against the code, not a rule.

- Canonicalize any file path a src-tauri command returns to the webview, as `document_for` does, because js/app.js compares paths by string equality and a symlink or /tmp vs /private/tmp never matches.
- In js/app.js, await the `set_document_open` or watch call that carries a new `watchGeneration` before invoking `open_documents`, because the app's DocumentRouter keeps its own state and a late update misroutes the files.
- In js/app.js, finish every step of an open that can fail (type check, reading the file, folder contents) before awaiting `leaveEditor()`, because it discards unsaved edits for good and a rejected open would lose them.
- Normalise `\r\n` and `\r` to `\n` before looking for a marked token's `raw` in the document source, as `core.blockStarts` does, because `marked.lexer` rewrites line breaks and a multi-line raw is not a substring of a CRLF file.
- Write a file path into markdown through `linkDestination` in js/format.js, because `core.resolveRelativePath` cuts a link at the first `?` or `#` before decoding it, so an unencoded name resolves to the wrong file.
- When Rich mode in scripts/codemirror-entry.mjs reads link targets or heading text from the lezer tree, match what marked renders (mailto: for emails, heading textContent for slugs), or ⌘-click and #anchors land elsewhere than in the rendered view.
- Force a full parse with `ensureSyntaxTree` before code or a test reads `syntaxTree(state)` from a new state, because CodeMirror first parses for only 20 ms and 3000 characters, so later headings go missing under load.
- Pass any menu label built from runtime text (file or folder names) through `menu_label` in src-tauri/src/lib.rs, because muda reads `&` as a mnemonic: macOS drops it and GTK underlines the next letter.
- Call `setAutoenablesItems(true)` on any menu you add native NSMenu items to in src-tauri, because muda turns auto-enabling off on every menu it builds, so responder-chain items otherwise never disable.
- In src-tauri, take a path apart with `Path::components()` rather than string checks like `!= "/"`, and build expected paths in tests with `MAIN_SEPARATOR`, because CI runs `cargo test` on Windows.
- When adding a markychecky command, implement it in markychecky.py and src-tauri/src/markychecky.rs and bump the `markychecky-hook-engine-N` marker everywhere it appears, or older installed apps are handed commands they don't know.
- When changing src-tauri/src/markychecky.rs, match Python's semantics rather than ASCII (`\d` and `int()` take any Unicode decimal digit, `fromisoformat` takes `+HH` offsets), because both engines must write byte-identical boards.
- In plugins/markychecky, load, update and save a session's state inside `write_board`'s locked update callback, because Claude Code runs one session's PostToolUse hooks at the same time and unlocked writes drop tasks.
- When a pull request changes anything under plugins/markychecky, bump `version` in its .claude-plugin/plugin.json, because `claude plugin update` compares only that string and existing users otherwise never get the new files.
- When changing the `release` job in .github/workflows/release.yml, run its shell steps in tests/release.test.js against the folders download-artifact leaves, because pull request dry runs never reach that job.
- Keep the Linux build tools release.yml installs in step with `LINUX_PACKAGES` in scripts/build-desktop.sh, because GitHub's runners carry newer tools (CMake in /usr/local/bin) that would hide a gap in the documented local build.
