import * as vscode from 'vscode';
import assert from 'node:assert/strict';
export async function run() {
  const extension = vscode.extensions.getExtension('forge-review.forge-review');
  assert.ok(extension, 'Extension is discoverable');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ['open', 'inline', 'cancel', 'undo']) assert.ok(commands.includes(`forgeReview.${command}`));
  await vscode.commands.executeCommand('forgeReview.open');
  await vscode.commands.executeCommand('forgeReview.cancel');
}
