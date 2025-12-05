/**
 * Worker thread for parallel AST parsing.
 * This file is executed by piscina worker threads.
 */

import { parseFile, ParsedFile } from './parser';

export interface ParseTask {
  filePath: string;
}

export interface ParseResult {
  success: boolean;
  data?: ParsedFile;
  error?: string;
}

/**
 * Parse a single file in a worker thread.
 * This function is called by piscina for each file.
 */
export default function parseFileWorker(task: ParseTask): ParseResult {
  try {
    const parsed = parseFile(task.filePath);
    return {
      success: true,
      data: parsed,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
