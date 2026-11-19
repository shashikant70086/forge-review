# TrueFoundry Forge-a-thon build plan

Registration closes November 15, 2026. Round 1 is due November 20 at 23:59 IST. [Official competition page](https://techfest.org/competitions/forge-a-thon)

## First working slice

1. Start the official local TrueForge package with `npx @truefoundry/trueforge@latest` and configure a tool-capable model in TrueForge Settings. Check out Flask `3.1.3` and verify the commit starts with `22d92470`.
2. Build a small VS Code extension from scratch. An inline command captures the selection and its document version, prompts for an instruction, and starts a TrueForge session. Stream the turn into an editor panel with a cancel action.
3. Expose the workspace through a local MCP server. Start with a scoped `read_file` and `propose_edit`. Require TrueForge approval for proposals. Open a native diff against a virtual document and record a decision for each hunk.
4. Keep approved hunks staged in memory until the turn succeeds. Revalidate the original document versions and apply accepted hunks through one text-only `WorkspaceEdit` so VS Code can undo them. Discard staged changes on cancellation or failure.

## Agent mode and failure handling

- Add MCP search and bounded command execution. Run verification commands on a disposable workspace copy containing the staged edits, with explicit approval for command execution.
- Resolve explicit `@file` and `@symbol` references first. For implicit retrieval, rank line windows by query matches in identifiers, paths and surrounding text, then deduplicate overlapping results. Start with a 12,000-character automatic retrieval budget and show each chosen path, line range and match reason in the panel. Keep targeted reads available for follow-up.
- Enable TrueForge deferred tool loading and verify it in the recorded session before claiming the integration score. Confirm the approval event payload exposes enough information to render the proposal before approving the call.
- On a retryable provider failure, discard the failed attempt and start a clean TrueForge session with the configured fallback model. Bound attempts and surface a concise error if both fail. Cancellation closes the local run immediately and sends TrueForge's turn cancellation request.

## Round 1 rehearsal

| Task | Evidence to record |
| --- | --- |
| A | Select `get_debug_flag`, submit the exact prompt, review hunks and show `False` with `FLASK_DEBUG=off`. Demonstrate VS Code undo. |
| B | Submit the exact prompt with no filenames. Show retrieval reasons, review at least three changed files, and open the TrueForge session with its tool calls. Show `pytest tests/test_cli.py -q` passing and run `flask config` with masked sample values. |
| C | Start from a clean checkout, use a broken model configuration, repeat A and show a responsive editor plus the fallback or error. Leave the proposal unapplied and show empty `git status --short` output. |

Exercise mid-stream cancellation in rehearsal and capture it in the demo if time allows. Keep the recording under four minutes in A, B, C order. Submit the public repository, public demo link and a 1–3 page PDF with the eight required headings and verified timestamps. Record the model names, hosting and approximate cost as soon as a live run works.

[TrueForge quickstart](https://trueforge.dev/quickstart) · [SDK streaming, approvals and cancellation](https://trueforge.dev/api/use-agent)
