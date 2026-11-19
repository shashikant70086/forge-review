# Forge Review

A local VS Code coding agent built from scratch for the TrueFoundry Forge-a-thon. TrueForge owns model calls, tool execution, streaming, approvals and session history. The extension exposes editor tools over authenticated loopback MCP and stages reviewed changes in memory.

Techfest team ID **TM-7B0390F45CF**. Public repository [shashikant70086/forge-review](https://github.com/shashikant70086/forge-review).

The Round 1 write-up is in [output/pdf/Forge_Review_Round_1_Writeup.pdf](output/pdf/Forge_Review_Round_1_Writeup.pdf). See [submission/DEMO_SCRIPT.md](submission/DEMO_SCRIPT.md) for the recording plan and [submission/SUBMISSION.md](submission/SUBMISSION.md) for deliverables and verification status.

## Run locally

1. Install Node.js 22.14 or newer and VS Code 1.105 or newer.
2. Run `npm ci` and `npm run build` in this repository.
3. On Windows run `./scripts/start-trueforge.ps1` and open http://localhost:8790. The launcher allows localhost editor MCP connections. On macOS/Linux run `OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1","localhost"]' npx @truefoundry/trueforge@0.183.2`. Configure your provider and a tool-capable model in Settings. Restart an existing TrueForge process with this allowance before connecting the extension.
4. Open this repository in VS Code and press F5. Open a local repository in the Extension Development Host. Alternatively run `npm run package` and install the resulting VSIX using Extensions → Install from VSIX.
5. Set `forgeReview.model` in VS Code Settings to the model's full TrueForge name. Optionally set `forgeReview.fallbackModel` to a second configured model.
6. Run **Forge Review: Open Agent**, describe a change and click Run agent. Select code and press Ctrl+Alt+I (Cmd+Alt+I on macOS) for an inline edit.
7. Review each proposed hunk, open its native diff if needed, and choose Continue agent. When the agent finishes, choose Apply accepted edits. Save the edited documents to persist them. Undo last change restores the pre-apply text if those documents still match the applied result.

### Choose your models

Models and credentials belong to each user's TrueForge installation. No provider credentials are bundled with the extension. The primary model setting is empty until the user configures it. Copy the values in `model-config.example.json` into VS Code User Settings as a starting point. It proposes OpenAI `gpt-4.1` and optional fallback `gpt-4.1-mini`. Configure those models in TrueForge first and use the exact full names shown by your server, including your provider's configured name. Other tool-capable models supported by TrueForge can be selected through the same settings.

The example models have not been used for a live competition run in this checkout. Costs depend on the provider account and actual usage. Configure provider API keys only in TrueForge Settings. For reproducible Flask demo setup, run `./scripts/prepare-demo.ps1`.

## Context and execution

Use `@file(src/example.py)`, `@file:src/example.py`, or `@src/example.py` for explicit file context. Search also locates identifiers mentioned in the request. Retrieval ranks code windows using path and content matches, with a default 12,000-character budget. The panel shows selected paths, line ranges and reasons. Targeted reads remain available through MCP.

The bundled `trueforge/agent.json` is the agent definition. The extension loads this definition, substitutes the configured model and a temporary MCP server name, then creates an inline TrueForge session. Deferred tool discovery eagerly loads retrieval. Compaction is enabled. Each run registers its own bearer-authenticated loopback endpoint and removes its registration on exit.

The command tool requests approval for the executable and argument array. It uses a temporary copy containing accepted staged edits. Commands run with your account permissions, including network and absolute-path access. Approve commands only after reviewing them. The copy has a 32 MiB limit and omits dependency directories, Git metadata, ignored paths and common credential files. Install verification dependencies in the environment before using commands.

## Verification

Run `npm run check`, `npm test`, and `npm run build`. Windows tests require permission to create a junction and terminate spawned processes. `npm run package` creates an installable VSIX.

Tests cover independent hunk decisions, stale proposals, line endings, path confinement, ignored files, retrieval budgets, temporary command copies, cancellation, timeouts and output limits.

The real TrueForge protocol integration has also passed streaming, deferred tool discovery, approval/resume, provider failure with automatic fallback, and cancellation using a deterministic local model simulator. To reproduce, start `./scripts/start-trueforge.ps1 -Port 8792 -DataSuffix forge-review-test`, then run `npx tsx scripts/test-harness.ts`. The simulator registers and removes its temporary provider automatically. It verifies protocol behavior and does not assess coding quality. `npm run test:integration` verifies activation and command registration in VS Code.

## Current limitations

This is an initial implementation requiring live model and VS Code acceptance testing before release. Agent proposals currently edit existing UTF-8 text files. File creation, deletion and rename are unsupported by the editor integration. Indexing is bounded to 5,000 files and individual reads to 256 KiB. Context retrieval uses lexical matches. Each request creates a fresh session. Commands can access paths outside their temporary working directory. Unsaved buffers are read for targeted file reads, while automatic retrieval uses disk contents.

Verification on 20 November 2026 passed TypeScript checking, all 13 automated tests, bundling, VSIX packaging and installed VS Code activation/command registration. Windows Application Control blocked the local TrueForge runtime's SQLite module during the current live-run attempt. The public Tasks A/B/C recording, runtime model declaration and measured provider cost remain pending. See the submission checklist before submitting to the organisers.

## Attribution

Starting point is from scratch. Runtime dependencies include TrueForge SDK (MIT), MCP TypeScript SDK (MIT), jsdiff (BSD-3-Clause), node-ignore (MIT), and Zod (MIT). AI assistance used during development includes OpenAI Codex. Dependency notices are included in `THIRD-PARTY-NOTICES.txt`.
