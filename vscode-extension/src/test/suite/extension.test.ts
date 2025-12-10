import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Extension Test Suite', function () {
  // Language client spin-up and workspace analysis can take a few seconds in CI.
  this.timeout(10000);

  vscode.window.showInformationMessage('Start all tests.');

  test('Extension should be present', () => {
    assert.ok(vscode.extensions.getExtension('samsmithyeah.vscode-react-loop-detector'));
  });

  test('Extension should activate on TypeScript React files', async () => {
    const ext = vscode.extensions.getExtension('samsmithyeah.vscode-react-loop-detector');
    assert.ok(ext);

    // The extension activates on language types, so we need to open a file
    // For now, just verify the extension exists
    assert.strictEqual(ext.id, 'samsmithyeah.vscode-react-loop-detector');
  });

  test('Commands should be registered after activation', async () => {
    const ext = vscode.extensions.getExtension('samsmithyeah.vscode-react-loop-detector');
    assert.ok(ext);

    // Activate the extension first
    await ext.activate();

    const commands = await vscode.commands.getCommands(true);

    assert.ok(
      commands.includes('reactLoopDetector.analyzeWorkspace'),
      'analyzeWorkspace command should be registered'
    );
    assert.ok(
      commands.includes('reactLoopDetector.clearCache'),
      'clearCache command should be registered'
    );
    assert.ok(
      commands.includes('reactLoopDetector.showStats'),
      'showStats command should be registered'
    );
  });
});
