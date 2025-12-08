import * as path from 'path';
import {
  ExtensionContext,
  workspace,
  commands,
  window,
  StatusBarAlignment,
  StatusBarItem,
  ConfigurationChangeEvent,
} from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;
let statusBarItem: StatusBarItem;
let lastIssueCount = 0;

interface RldStats {
  cachedFiles: number;
  dependencyEdges: number;
  totalIssues: number;
  crossFileCycles: number;
}

// Status bar states
const STATUS = {
  ready: { text: '$(shield) RLD', tooltip: 'React Loop Detector - Ready' },
  readyWithIssues: (count: number) => ({
    text: `$(warning) RLD: ${count}`,
    tooltip: `React Loop Detector - ${count} issue${count !== 1 ? 's' : ''} found`,
  }),
  analyzing: {
    text: '$(sync~spin) RLD',
    tooltip: 'React Loop Detector - Analyzing...',
  },
  analyzingFull: {
    text: '$(sync~spin) RLD (full)',
    tooltip: 'React Loop Detector - Full cross-file analysis...',
  },
  disabled: {
    text: '$(shield) RLD (off)',
    tooltip: 'React Loop Detector - Disabled',
  },
  error: {
    text: '$(error) RLD',
    tooltip: 'React Loop Detector - Error',
  },
};

function updateStatusBar(state: keyof typeof STATUS, issueCount?: number): void {
  const statusEntry = STATUS[state];
  let status: { text: string; tooltip: string } | undefined;

  if (typeof statusEntry === 'function') {
    if (issueCount !== undefined) {
      status = statusEntry(issueCount);
    }
  } else {
    status = statusEntry;
  }

  if (status) {
    statusBarItem.text = status.text;
    statusBarItem.tooltip = status.tooltip;
    statusBarItem.backgroundColor = undefined;
  }
}

export function activate(context: ExtensionContext): void {
  // Create status bar item
  statusBarItem = window.createStatusBarItem(StatusBarAlignment.Right, 100);
  statusBarItem.command = 'reactLoopDetector.analyzeWorkspace';
  updateStatusBar('ready');
  context.subscriptions.push(statusBarItem);

  // Server module path
  const serverModule = context.asAbsolutePath(path.join('dist', 'server', 'server.js'));

  // Server options
  const serverOptions: ServerOptions = {
    run: {
      module: serverModule,
      transport: TransportKind.ipc,
    },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: {
        execArgv: ['--nolazy', '--inspect=6009'],
      },
    },
  };

  // Client options
  const clientOptions: LanguageClientOptions = {
    documentSelector: [
      { scheme: 'file', language: 'javascript' },
      { scheme: 'file', language: 'javascriptreact' },
      { scheme: 'file', language: 'typescript' },
      { scheme: 'file', language: 'typescriptreact' },
    ],
    synchronize: {
      fileEvents: [
        workspace.createFileSystemWatcher('**/rld.config.{js,json}'),
        workspace.createFileSystemWatcher('**/.rldrc'),
        workspace.createFileSystemWatcher('**/.rldrc.json'),
      ],
    },
    initializationOptions: {
      settings: workspace.getConfiguration('reactLoopDetector'),
    },
  };

  // Create and start the client
  client = new LanguageClient(
    'reactLoopDetector',
    'React Loop Detector',
    serverOptions,
    clientOptions
  );

  // Register commands
  context.subscriptions.push(
    commands.registerCommand('reactLoopDetector.analyzeWorkspace', async () => {
      updateStatusBar('analyzingFull');

      try {
        await client.sendRequest('reactLoopDetector/analyzeWorkspace');
        window.showInformationMessage('React Loop Detector: Analysis complete');
      } catch (error) {
        updateStatusBar('error');
        window.showErrorMessage(
          `React Loop Detector: Analysis failed - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  context.subscriptions.push(
    commands.registerCommand('reactLoopDetector.clearCache', async () => {
      try {
        await client.sendRequest('reactLoopDetector/clearCache');
        lastIssueCount = 0;
        updateStatusBar('ready');
        window.showInformationMessage('React Loop Detector: Cache cleared');
      } catch (error) {
        window.showErrorMessage(
          `React Loop Detector: Failed to clear cache - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  context.subscriptions.push(
    commands.registerCommand('reactLoopDetector.showStats', async () => {
      try {
        const stats = (await client.sendRequest('reactLoopDetector/getStats')) as RldStats;

        window.showInformationMessage(
          `React Loop Detector Stats:\n` +
            `Files cached: ${stats.cachedFiles}\n` +
            `Dependency edges: ${stats.dependencyEdges}\n` +
            `Total issues: ${stats.totalIssues}\n` +
            `Cross-file cycles: ${stats.crossFileCycles}`
        );
      } catch (error) {
        window.showErrorMessage(
          `React Loop Detector: Failed to get stats - ${error instanceof Error ? error.message : String(error)}`
        );
      }
    })
  );

  // Start the client and set up notification handlers
  client
    .start()
    .then(() => {
      statusBarItem.show();

      // Check if extension is enabled
      const config = workspace.getConfiguration('reactLoopDetector');
      if (!config.get('enable', true)) {
        updateStatusBar('disabled');
      }

      // Handle analysis started notification
      client.onNotification(
        'reactLoopDetector/analysisStarted',
        (params: { type: 'single' | 'full' }) => {
          if (params.type === 'full') {
            updateStatusBar('analyzingFull');
          } else {
            updateStatusBar('analyzing');
          }
        }
      );

      // Handle analysis complete notification
      client.onNotification(
        'reactLoopDetector/analysisComplete',
        (params: { type: 'single' | 'full'; issueCount: number; filesAnalyzed: number }) => {
          lastIssueCount = params.issueCount;

          if (params.issueCount > 0) {
            updateStatusBar('readyWithIssues', params.issueCount);
          } else {
            updateStatusBar('ready');
          }
        }
      );
    })
    .catch((error) => {
      updateStatusBar('error');
      window.showErrorMessage(
        `React Loop Detector: Failed to start - ${error instanceof Error ? error.message : String(error)}`
      );
    });

  // Listen for configuration changes
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e: ConfigurationChangeEvent) => {
      if (e.affectsConfiguration('reactLoopDetector.enable')) {
        const config = workspace.getConfiguration('reactLoopDetector');
        const enabled = config.get('enable', true);

        if (enabled) {
          if (lastIssueCount > 0) {
            updateStatusBar('readyWithIssues', lastIssueCount);
          } else {
            updateStatusBar('ready');
          }
        } else {
          updateStatusBar('disabled');
        }
      }
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
