import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  try {
    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // The path to the extension test script
    const extensionTestsPath = path.resolve(__dirname, './suite/index');

    // Launch args for headless/CI mode
    const launchArgs: string[] = [
      '--disable-extensions', // Disable other extensions for faster, isolated tests
    ];

    // On Linux CI, xvfb-run provides a virtual display
    // On macOS/Windows, we can't truly run headless, but these flags help
    if (process.env.CI || process.env.HEADLESS) {
      launchArgs.push('--disable-gpu', '--no-sandbox');
    }

    // Download VS Code, unzip it and run the integration test
    await runTests({
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs,
    });
  } catch (err) {
    console.error('Failed to run tests', err);
    process.exit(1);
  }
}

main();
