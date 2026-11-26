# markydowny

## Notes from the fleet

Written by the fleet's agents while addressing review feedback. No person has reviewed these lines: treat each as a suggestion to weigh against the code, not a rule.

- markychecky has two implementations that must write identical boards: `plugins/markychecky/scripts/markychecky.py` and `src-tauri/src/markychecky.rs`. Change both together. When you add a command, also bump the `markychecky-hook-engine-N` marker everywhere it appears, so an older app is not handed a command it does not know.
- Bump `version` in `plugins/markychecky/.claude-plugin/plugin.json` whenever anything under `plugins/markychecky` changes. People who already installed the plugin only get new files when that version changes.
- CI runs `cargo test` on Windows. In `src-tauri`, take paths apart with `Path::components()` and build expected paths in tests with `MAIN_SEPARATOR`; string checks against `/` fail there.
- Canonicalize a file path before a `src-tauri` command returns it to the web view. The front end compares paths as plain strings, so a symlink, or `/tmp` against `/private/tmp`, would not match.
