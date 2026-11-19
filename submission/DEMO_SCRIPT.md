# Forge Review demo recording plan

Team **TM-7B0390F45CF**. Target duration **3 minutes 50 seconds**. Times below are planned cues. Record actual execution, and show cuts or speed changes when compressing wait time. Use an approved working local TrueForge runtime and your configured model. This document is a recording script.

## Preparation

1. Build and install `forge-review-0.1.0.vsix` or launch the extension development host with F5.
2. Start `scripts/start-trueforge.ps1`. Configure model credentials in TrueForge and choose the exact primary/fallback names in VS Code User Settings.
3. Run `scripts/prepare-demo.ps1`. Open `.demo/flask` in the extension host. In a Python environment, install `python -m pip install -e ".[dotenv]" pytest pytest-asyncio asgiref` from the Flask folder.
4. Verify `git rev-parse HEAD` equals `22d924701a6ae2e4cd01e9a15bbaf3946094af65`. Run `python -m pytest tests/test_cli.py -q` before recording.
5. Keep provider credentials, unrelated windows and account information out of the recording. Keep terminal output readable. Check the original problem statement for the exact prompts before recording.

## 00 00 to 00 15 Introduction

Show Forge Review in VS Code, the Flask revision, TrueForge version and configured model names. Say “This is Forge Review, team TM-7B0390F45CF. TrueForge runs the agent loop. The extension supplies editor tools through MCP and lets the developer review each hunk.”

## 00 15 to 01 00 Task A Inline edit

Select `get_debug_flag` in `src/flask/helpers.py`, then press Ctrl+Alt+I. Rehearsal instruction follows.

> Treat off and n as false values, case-insensitively, and document every false value accepted by get_debug_flag.

Show streamed output, the native diff and hunk decisions. Accept the requested edits, continue the agent, apply and save. From the Flask terminal run the following.

```powershell
$env:FLASK_DEBUG='off'
python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"
Remove-Item Env:FLASK_DEBUG
```

Show `False`. Use Forge Review's Undo last change, save, and show the original text restored. This explicit undo command is part of the extension. Check `git status --short` before continuing.

## 01 00 to 02 45 Task B Agent mode

Open Forge Review and enter a request without naming files. Rehearsal instruction follows.

> Add a built-in flask config command that displays the loaded application's configuration as JSON. Mask values whose keys contain SECRET, PASSWORD, TOKEN or KEY. Include a regression test and document the command with the other built-in commands.

Show the selected context, reasons and character budget. Let TrueForge discover source, tests and documentation. Review hunks in at least three files and show a rejected hunk if the model proposes an optional change. Continue the agent, apply accepted edits and save. Open the TrueForge session to show tool discovery and execution. Verify from the Flask terminal.

```powershell
git diff --stat
python -m pytest tests/test_cli.py -q
python -m flask --app 'flask:Flask("demo")' --help
```

For a demonstrable configuration, use an external scratch app or the command below. It creates no file in the Flask checkout.

```powershell
python -c "from flask import Flask; a=Flask('demo'); a.config.update(APP_SECRET='demo-secret', DB_PASSWORD='demo-password', AUTH_TOKEN='demo-token', API_KEY='demo-key'); r=a.test_cli_runner().invoke(args=['config']); print(r.output); raise SystemExit(r.exit_code)"
```

Show valid JSON, masked sensitive sample values and the actual test result. Do not replace failed runs with invented success output.

## 02 45 to 03 35 Task C Resilience

Prepare a separate clean Flask checkout with `scripts/prepare-demo.ps1 -Destination .demo/flask-resilience` before recording this segment. Use a deliberately unreachable endpoint or invalid test credential in a separate TrueForge model configuration. Do not overwrite working credentials. Set that configuration as the primary model and keep the healthy fallback optional.

Repeat Task A. Show retry/fallback status or the final readable error, a responsive editor and `git status --short` in the clean checkout. Leave any recovered proposal unapplied. Show cancellation on a real in-progress run if time permits, with proposed changes discarded. The editor test fixture alone cannot supply this evidence.

## 03 35 to 03 50 Closing

Show public repository and PDF. State the actual model used and one current limit, such as existing-text-file editing only. End by 03 50, leaving ten seconds below the four-minute limit.
