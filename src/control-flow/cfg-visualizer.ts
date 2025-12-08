/**
 * CFG Visualizer - Generates DOT format output for visualizing Control Flow Graphs.
 *
 * The DOT format can be rendered using Graphviz (https://graphviz.org/) or
 * online tools like https://dreampuf.github.io/GraphvizOnline/
 *
 * Usage:
 *   const dot = cfgToDot(cfg);
 *   console.log(dot);  // Copy to Graphviz
 */

import type { CFG, CFGNode, CFGNodeType } from './cfg-types';

/**
 * Options for DOT generation.
 */
export interface DotOptions {
  /** Include unreachable nodes (shown in gray) */
  showUnreachable?: boolean;

  /** Show node IDs in labels */
  showNodeIds?: boolean;

  /** Highlight specific nodes (e.g., setState calls) */
  highlightNodes?: Set<string>;

  /** Title for the graph */
  title?: string;

  /** Use left-to-right layout instead of top-to-bottom */
  leftToRight?: boolean;
}

/**
 * Convert a CFG to DOT format for visualization.
 */
export function cfgToDot(cfg: CFG, options: DotOptions = {}): string {
  const {
    showUnreachable = true,
    showNodeIds = false,
    highlightNodes = new Set(),
    title = 'Control Flow Graph',
    leftToRight = false,
  } = options;

  const lines: string[] = [];

  // Graph header
  lines.push('digraph CFG {');
  lines.push(`  label="${escapeLabel(title)}";`);
  lines.push('  labelloc="t";');
  lines.push('  fontsize=16;');
  lines.push(`  rankdir="${leftToRight ? 'LR' : 'TB'}";`);
  lines.push('  node [fontname="monospace", fontsize=10];');
  lines.push('  edge [fontname="monospace", fontsize=9];');
  lines.push('');

  // Generate nodes
  for (const [id, node] of cfg.nodes) {
    if (!showUnreachable && !node.reachable) continue;

    const label = formatNodeLabel(node, showNodeIds);
    const attrs = getNodeAttributes(node, highlightNodes.has(id));
    lines.push(`  "${id}" [label="${escapeLabel(label)}"${attrs}];`);
  }

  lines.push('');

  // Generate edges
  const edgesSeen = new Set<string>();

  for (const [id, node] of cfg.nodes) {
    if (!showUnreachable && !node.reachable) continue;

    for (const succ of node.successors) {
      if (!showUnreachable && !succ.reachable) continue;

      const edgeKey = `${id}->${succ.id}`;
      if (edgesSeen.has(edgeKey)) continue;
      edgesSeen.add(edgeKey);

      const edgeAttrs = getEdgeAttributes(node, succ);
      lines.push(`  "${id}" -> "${succ.id}"${edgeAttrs};`);
    }
  }

  lines.push('}');

  return lines.join('\n');
}

/**
 * Format the label for a node.
 */
function formatNodeLabel(node: CFGNode, showId: boolean): string {
  let label = node.label;

  // Truncate long labels
  if (label.length > 40) {
    label = label.substring(0, 37) + '...';
  }

  if (showId) {
    label = `[${node.id}] ${label}`;
  }

  // Add location info if available
  if (node.loc) {
    label = `${label}\\n(line ${node.loc.line})`;
  }

  return label;
}

/**
 * Get DOT attributes for a node based on its type.
 */
function getNodeAttributes(node: CFGNode, isHighlighted: boolean): string {
  const attrs: string[] = [];

  // Shape based on node type
  const shape = getNodeShape(node.type);
  attrs.push(`shape=${shape}`);

  // Color based on type and state
  if (isHighlighted) {
    attrs.push('fillcolor="#ffcccc"');
    attrs.push('style=filled');
    attrs.push('penwidth=2');
  } else if (!node.reachable) {
    attrs.push('fillcolor="#eeeeee"');
    attrs.push('style="filled,dashed"');
    attrs.push('fontcolor="#888888"');
  } else {
    const color = getNodeColor(node.type);
    if (color) {
      attrs.push(`fillcolor="${color}"`);
      attrs.push('style=filled');
    }
  }

  return attrs.length > 0 ? `, ${attrs.join(', ')}` : '';
}

/**
 * Get the shape for a node type.
 */
function getNodeShape(type: CFGNodeType): string {
  switch (type) {
    case 'entry':
    case 'exit':
      return 'ellipse';
    case 'branch':
    case 'loop-test':
      return 'diamond';
    case 'merge':
      return 'point';
    case 'return':
    case 'throw':
    case 'break':
    case 'continue':
      return 'box';
    case 'try':
    case 'catch':
    case 'finally':
      return 'hexagon';
    default:
      return 'box';
  }
}

/**
 * Get the fill color for a node type.
 */
function getNodeColor(type: CFGNodeType): string | null {
  switch (type) {
    case 'entry':
      return '#90EE90'; // Light green
    case 'exit':
      return '#FFB6C1'; // Light pink
    case 'branch':
    case 'loop-test':
      return '#87CEEB'; // Sky blue
    case 'return':
      return '#DDA0DD'; // Plum
    case 'throw':
      return '#FFA07A'; // Light salmon
    case 'try':
      return '#E6E6FA'; // Lavender
    case 'catch':
      return '#FFDAB9'; // Peach puff
    case 'finally':
      return '#F0E68C'; // Khaki
    case 'break':
    case 'continue':
      return '#D3D3D3'; // Light gray
    default:
      return null;
  }
}

/**
 * Get DOT attributes for an edge.
 */
function getEdgeAttributes(from: CFGNode, to: CFGNode): string {
  const attrs: string[] = [];

  // Label and style based on edge type
  if (from.type === 'branch' || from.type === 'loop-test') {
    if (from.trueSuccessor === to) {
      attrs.push('label="T"');
      attrs.push('color="#228B22"'); // Forest green
    } else if (from.falseSuccessor === to) {
      attrs.push('label="F"');
      attrs.push('color="#DC143C"'); // Crimson
    }
  }

  // Back edges (loops)
  if (to.type === 'loop-test' && from.type !== 'branch') {
    attrs.push('style=dashed');
    attrs.push('constraint=false');
  }

  // Exception edges
  if (from.type === 'throw' || to.type === 'catch') {
    attrs.push('style=dotted');
    attrs.push('color="#FF4500"'); // Orange red
  }

  return attrs.length > 0 ? ` [${attrs.join(', ')}]` : '';
}

/**
 * Escape special characters for DOT labels.
 */
function escapeLabel(label: string): string {
  return label.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/**
 * Print CFG statistics.
 */
export function cfgStats(cfg: CFG): string {
  let totalNodes = 0;
  let reachableNodes = 0;
  let branchNodes = 0;
  let loopNodes = 0;
  let terminators = 0;

  for (const node of cfg.nodes.values()) {
    totalNodes++;
    if (node.reachable) reachableNodes++;
    if (node.type === 'branch') branchNodes++;
    if (node.type === 'loop-test') loopNodes++;
    if (
      node.type === 'return' ||
      node.type === 'throw' ||
      node.type === 'break' ||
      node.type === 'continue'
    ) {
      terminators++;
    }
  }

  const unreachable = totalNodes - reachableNodes;

  return [
    `CFG Statistics:`,
    `  Total nodes: ${totalNodes}`,
    `  Reachable: ${reachableNodes}`,
    `  Unreachable: ${unreachable}`,
    `  Branch points: ${branchNodes}`,
    `  Loop tests: ${loopNodes}`,
    `  Terminators: ${terminators}`,
  ].join('\n');
}
