# Forge Review Round 1 submission

Techfest team ID **TM-7B0390F45CF**

## Submission fields

| Field | Value |
| --- | --- |
| Project | Forge Review |
| Public source | https://github.com/shashikant70086/forge-review |
| PDF | `output/pdf/Forge_Review_Round_1_Writeup.pdf` |
| Demo video | Pending real Tasks A, B and C recording and public upload |
| Submission form | https://forms.gle/htyWGFJRBgsg3qmx6 |
| Deadline | 20 November 2026, 23:59 IST |

## Configured models declaration

The extension is user-configurable. Its default model setting is empty and it makes no direct provider requests. The supplied example selects `openai/gpt-4.1` as primary and `openai/gpt-4.1-mini` as optional fallback, hosted through the user's OpenAI provider configured inside local TrueForge. Replace the provider prefixes with the exact configured names from your TrueForge instance. No model/provider exists in the inspected local TrueForge database. The example has not been validated in a live model run. No measured provider cost is available.

## Verified implementation

On 20 November 2026, TypeScript checking, 13 automated tests, bundling, VSIX packaging, and extension activation/command registration in installed VS Code passed. Localhost and Windows junction tests require ordinary process permissions outside the restricted execution sandbox. The existing deterministic TrueForge protocol harness is available in `scripts/test-harness.ts`. It is a fixture, and is excluded from claims of AI task completion.

## Remaining evidence

- Run local TrueForge in an environment where its native SQLite module is permitted. Current Windows Application Control rejects the installed module. Keep the operating system policy intact and use an approved runtime environment.
- Configure your chosen primary and optional fallback model in TrueForge. Record actual model names, hosting and usage cost in the PDF after the live runs.
- Record Tasks A, B and C on Flask 3.1.3 at `22d924701a6ae2e4cd01e9a15bbaf3946094af65` with the original problem statement's exact instructions. The rehearsal prompts in `DEMO_SCRIPT.md` reflect the available brief, and require comparison to the full original statement.
- Upload a video of at most four minutes to a publicly accessible location. Replace planned cue times with actual timestamps.
- Review the PDF headings against the full original problem statement. The supplied brief does not enumerate required headings.
- Enter repository, PDF and public video links in the submission form with the team ID. The competition form has not been submitted.

The PDF is a technical write-up of the implemented system with explicit evidence limits. A successful Tasks A/B/C demonstration is still required for a complete competition submission.
