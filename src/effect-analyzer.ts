/**
 * Effect Analyzer Module
 *
 * Analyzes useEffect and useLayoutEffect hooks for infinite loop patterns.
 * This module handles:
 * - useEffect without dependency array detection
 * - State interaction analysis within effect callbacks
 * - Deferred modification detection (setInterval, onSnapshot, etc.)
 * - Function reference tracking (event listeners, callbacks)
 */

import * as t from '@babel/types';
import traverse, { NodePath } from '@babel/traverse';
import { HookAnalysis, StateInteraction } from './types';
import { isHookIgnored, createAnalysis } from './utils';
import { analyzeConditionalGuard } from './guard-analyzer';

/**
 * Detect useEffect calls without a dependency array that contain setState.
 * This is a guaranteed infinite loop pattern.
 *
 * Pattern detected:
 * ```
 * useEffect(() => {
 *   setCount(c => c + 1);
 * }); // Missing dependency array!
 * ```
 *
 * Also detects indirect patterns:
 * ```
 * const fetchData = () => { setData(x); };
 * useEffect(() => {
 *   fetchData(); // calls function that eventually calls setState
 * });
 * ```
 */
export function detectUseEffectWithoutDeps(
  ast: t.Node,
  stateInfo: Map<string, string>,
  filePath: string,
  fileContent?: string
): HookAnalysis[] {
  const results: HookAnalysis[] = [];
  const setterNames = new Set(stateInfo.values());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  // First pass: find local functions that call state setters (directly or indirectly)
  const functionsCallingSetters = new Map<string, string[]>(); // function name -> setters it calls

  // Helper to find setters called within a function body
  function findSettersCalledInFunction(
    funcPath: NodePath<t.ArrowFunctionExpression | t.FunctionExpression | t.ObjectMethod>
  ): string[] {
    const settersCalled: string[] = [];
    funcPath.traverse({
      CallExpression(innerCallPath: NodePath<t.CallExpression>) {
        // Check for direct calls: setData(x)
        if (t.isIdentifier(innerCallPath.node.callee)) {
          const calleeName = innerCallPath.node.callee.name;
          if (setterNames.has(calleeName)) {
            settersCalled.push(calleeName);
          }
        }

        // Check for setters passed as arguments: .then(setData)
        for (const arg of innerCallPath.node.arguments || []) {
          if (t.isIdentifier(arg) && setterNames.has(arg.name)) {
            settersCalled.push(arg.name);
          }
        }
      },
    });
    return settersCalled;
  }

  // Track object methods: const utils = { update: () => setCount(...) }
  // We track these as "objectName.methodName" for matching later
  const objectMethodsCallingSetters = new Map<string, string[]>(); // "obj.method" -> setters

  traverse(ast, {
    // Track arrow function assignments: const fetchData = () => { setData(...) }
    VariableDeclarator(varPath: NodePath<t.VariableDeclarator>) {
      if (!t.isIdentifier(varPath.node.id)) return;
      const varName = varPath.node.id.name;
      const init = varPath.node.init;

      // Handle direct function assignments
      if (t.isArrowFunctionExpression(init) || t.isFunctionExpression(init)) {
        const funcPath = varPath.get('init') as NodePath<
          t.ArrowFunctionExpression | t.FunctionExpression
        >;
        const settersCalled = findSettersCalledInFunction(funcPath);
        if (settersCalled.length > 0) {
          functionsCallingSetters.set(varName, settersCalled);
        }
      }

      // Handle object expressions: const utils = { update: () => setCount(...) }
      if (t.isObjectExpression(init)) {
        const objPath = varPath.get('init') as NodePath<t.ObjectExpression>;
        for (const propPath of objPath.get('properties')) {
          if (!propPath.isObjectProperty() && !propPath.isObjectMethod()) continue;

          const prop = propPath.node;
          let methodName: string | null = null;

          if (t.isIdentifier(prop.key)) {
            methodName = prop.key.name;
          } else if (t.isStringLiteral(prop.key)) {
            methodName = prop.key.value;
          }

          if (!methodName) continue;

          if (propPath.isObjectMethod()) {
            const settersCalled = findSettersCalledInFunction(propPath as NodePath<t.ObjectMethod>);
            if (settersCalled.length > 0) {
              objectMethodsCallingSetters.set(`${varName}.${methodName}`, settersCalled);
            }
          } else if (propPath.isObjectProperty()) {
            const value = (prop as t.ObjectProperty).value;
            if (t.isArrowFunctionExpression(value) || t.isFunctionExpression(value)) {
              const valuePath = (propPath as NodePath<t.ObjectProperty>).get('value') as NodePath<
                t.ArrowFunctionExpression | t.FunctionExpression
              >;
              const settersCalled = findSettersCalledInFunction(valuePath);
              if (settersCalled.length > 0) {
                objectMethodsCallingSetters.set(`${varName}.${methodName}`, settersCalled);
              }
            }
          }
        }
      }
    },

    // Track function declarations: function fetchData() { setData(...) }
    FunctionDeclaration(funcPath: NodePath<t.FunctionDeclaration>) {
      const funcName = funcPath.node.id?.name;
      if (!funcName) return;

      // Skip component functions (PascalCase)
      if (/^[A-Z]/.test(funcName)) return;

      const settersCalled = findSettersCalledInFunction(
        funcPath as unknown as NodePath<t.FunctionExpression>
      );
      if (settersCalled.length > 0) {
        functionsCallingSetters.set(funcName, settersCalled);
      }
    },
  });

  // Second pass: find useEffect without deps
  traverse(ast, {
    CallExpression(callPath: NodePath<t.CallExpression>) {
      if (!t.isIdentifier(callPath.node.callee)) return;
      const hookName = callPath.node.callee.name;

      // Only check useEffect and useLayoutEffect
      if (hookName !== 'useEffect' && hookName !== 'useLayoutEffect') return;

      const args = callPath.node.arguments;

      // Check if there's no dependency array (only 1 argument - the callback)
      if (args.length !== 1) return;

      const callback = args[0];
      if (!t.isArrowFunctionExpression(callback) && !t.isFunctionExpression(callback)) return;

      const line = callPath.node.loc?.start.line || 0;

      // Check for ignore comments
      if (fileContent && isHookIgnored(fileContent, line)) return;

      // Check if the callback contains any setState calls (direct or indirect)
      const setterCallsInCallback: string[] = [];
      const functionCallsInCallback: string[] = [];

      const callbackPath = callPath.get('arguments.0') as NodePath<
        t.ArrowFunctionExpression | t.FunctionExpression
      >;
      callbackPath.traverse({
        CallExpression(innerCallPath: NodePath<t.CallExpression>) {
          const callee = innerCallPath.node.callee;

          // Handle direct function calls: funcName()
          if (t.isIdentifier(callee)) {
            const calleeName = callee.name;

            // Direct setter call
            if (setterNames.has(calleeName)) {
              setterCallsInCallback.push(calleeName);
            }

            // Function call that might lead to setter
            if (functionsCallingSetters.has(calleeName)) {
              functionCallsInCallback.push(calleeName);
              const indirectSetters = functionsCallingSetters.get(calleeName) || [];
              setterCallsInCallback.push(...indirectSetters);
            }
          }

          // Handle member expression calls: obj.method()
          if (
            t.isMemberExpression(callee) &&
            t.isIdentifier(callee.object) &&
            t.isIdentifier(callee.property)
          ) {
            const methodKey = `${callee.object.name}.${callee.property.name}`;
            if (objectMethodsCallingSetters.has(methodKey)) {
              functionCallsInCallback.push(methodKey);
              const indirectSetters = objectMethodsCallingSetters.get(methodKey) || [];
              setterCallsInCallback.push(...indirectSetters);
            }
          }
        },
      });

      if (setterCallsInCallback.length > 0) {
        const firstSetter = setterCallsInCallback[0];
        const stateVar = setterToState.get(firstSetter) || firstSetter;
        const isIndirect = functionCallsInCallback.length > 0;

        results.push(
          createAnalysis({
            type: 'confirmed-infinite-loop',
            errorCode: 'RLD-201',
            category: 'critical',
            severity: 'high',
            confidence: isIndirect ? 'medium' : 'high',
            hookType: hookName,
            line,
            file: filePath,
            problematicDependency: 'missing-deps',
            stateVariable: stateVar,
            setterFunction: firstSetter,
            actualStateModifications: setterCallsInCallback,
            stateReads: [],
            explanation: isIndirect
              ? `${hookName} has no dependency array, so it runs after every render. ` +
                `It calls '${functionCallsInCallback[0]}()' which calls '${firstSetter}()', triggering re-renders. ` +
                `Fix: add a dependency array (e.g., [] for run-once, or [dep1, dep2] for specific dependencies).`
              : `${hookName} has no dependency array, so it runs after every render. ` +
                `It calls '${firstSetter}()' which triggers a re-render, causing an infinite loop. ` +
                `Fix: add a dependency array (e.g., [] for run-once, or [dep1, dep2] for specific dependencies).`,
          })
        );
      }
    },
  });

  return results;
}

// Common event listener methods that receive callback references (not invoked immediately)
const EVENT_LISTENER_METHODS = new Set([
  'addEventListener',
  'removeEventListener',
  'on',
  'off',
  'once',
  'addListener',
  'removeListener',
  'subscribe',
  'unsubscribe',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'then',
  'catch',
  'finally', // Promise methods
  'map',
  'filter',
  'forEach',
  'reduce',
  'find',
  'some',
  'every', // Array methods
]);

// Functions that execute their callbacks asynchronously (deferred execution)
// State modifications inside these callbacks won't cause immediate re-render loops
const ASYNC_CALLBACK_FUNCTIONS = new Set([
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'requestIdleCallback',
  'then',
  'catch',
  'finally', // Promise methods
  'onSnapshot',
  'onAuthStateChanged',
  'onValue',
  'onChildAdded',
  'onChildChanged',
  'onChildRemoved', // Firebase
  'subscribe',
  'observe', // Common subscription patterns
  'addEventListener', // Event listeners are async (user-triggered)
]);

/**
 * Analyze state interactions within a hook body.
 * Tracks:
 * - State reads and modifications
 * - Conditional vs unconditional modifications
 * - Functional updates
 * - Deferred modifications (inside async callbacks)
 * - Function references passed to event listeners
 * - Ref mutations
 */
export function analyzeStateInteractions(
  hookBody: t.Node,
  stateInfo: Map<string, string>,
  refVars: Set<string> = new Set()
): StateInteraction {
  const interactions: StateInteraction = {
    reads: [],
    modifications: [],
    conditionalModifications: [],
    functionalUpdates: [],
    deferredModifications: [],
    guardedModifications: [],
    functionReferences: [],
    refMutations: [],
  };

  const setterNames = Array.from(stateInfo.values());
  const stateNames = Array.from(stateInfo.keys());

  // Build reverse map: setter -> state variable
  const setterToState = new Map<string, string>();
  stateInfo.forEach((setter, state) => setterToState.set(setter, state));

  // Track ancestor chain for proper conditional analysis
  const ancestorStack: t.Node[] = [];

  // Track functions that are passed as arguments (not invoked)
  const functionsPassedAsArgs = new Set<string>();

  // Track CallExpression nodes that are async callback receivers
  const asyncCallbackNodes = new Set<t.Node>();

  // First pass: find all functions passed as arguments to known safe receivers
  // AND track async callback nodes (calls to setInterval, onSnapshot, etc. with inline callbacks)
  function findFunctionReferences(node: t.Node | null | undefined): void {
    if (!node || typeof node !== 'object') return;

    // Check for calls like: addEventListener('click', handleClick) or obj.addEventListener(...)
    if (node.type === 'CallExpression') {
      let receivingFuncName: string | null = null;

      // Handle: addEventListener('click', handler)
      if (node.callee?.type === 'Identifier') {
        receivingFuncName = node.callee.name;
      }
      // Handle: element.addEventListener('click', handler) or window.addEventListener(...)
      else if (
        node.callee?.type === 'MemberExpression' &&
        node.callee.property?.type === 'Identifier'
      ) {
        receivingFuncName = node.callee.property.name;
      }

      if (receivingFuncName && EVENT_LISTENER_METHODS.has(receivingFuncName)) {
        // Check each argument - if it's an identifier, it's passed as reference
        for (const arg of node.arguments || []) {
          if (arg.type === 'Identifier') {
            functionsPassedAsArgs.add(arg.name);
            interactions.functionReferences.push({
              functionName: arg.name,
              context: [
                'addEventListener',
                'removeEventListener',
                'on',
                'off',
                'addListener',
                'removeListener',
              ].includes(receivingFuncName)
                ? 'event-listener'
                : 'callback-arg',
              receivingFunction: receivingFuncName,
            });
          }
        }
      }

      // Track async callback function calls - these contain callbacks that execute asynchronously
      // e.g., setInterval(() => setCount(...), 1000) or onSnapshot(q, (snapshot) => { ... })
      if (receivingFuncName && ASYNC_CALLBACK_FUNCTIONS.has(receivingFuncName)) {
        // Mark all function arguments (arrow functions, function expressions) as async callbacks
        for (const arg of node.arguments || []) {
          if (arg.type === 'ArrowFunctionExpression' || arg.type === 'FunctionExpression') {
            asyncCallbackNodes.add(arg);
          }
        }
      }
    }

    // Recursively search
    const indexableNode = node as unknown as Record<string, unknown>;
    Object.keys(node).forEach((key) => {
      const value = indexableNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => findFunctionReferences(child as t.Node | null | undefined));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        findFunctionReferences(value as t.Node);
      }
    });
  }

  findFunctionReferences(hookBody);

  // Helper: check if current node is inside an async callback
  function isInsideAsyncCallback(): boolean {
    for (const ancestor of ancestorStack) {
      if (asyncCallbackNodes.has(ancestor)) {
        return true;
      }
    }
    return false;
  }

  // Create a simple traversal without @babel/traverse to avoid scope issues
  function visitNode(node: t.Node | null | undefined, parent?: t.Node | null): void {
    if (!node || typeof node !== 'object') return;

    ancestorStack.push(node);

    // Check for function calls (state setters)
    if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier') {
      const calleeName = node.callee.name;

      if (setterNames.includes(calleeName)) {
        const stateVar = setterToState.get(calleeName);

        // Check if this modification is inside an async callback (deferred)
        if (isInsideAsyncCallback()) {
          interactions.deferredModifications.push(calleeName);
        } else {
          // Not deferred, so analyze for loop risks
          const guardAnalysis = analyzeConditionalGuard(
            node,
            ancestorStack,
            calleeName,
            stateVar,
            stateNames
          );

          if (guardAnalysis) {
            interactions.guardedModifications.push(guardAnalysis);
            if (!guardAnalysis.isSafe) {
              interactions.conditionalModifications.push(calleeName);
            }
          } else {
            // If we couldn't analyze the guard, treat as a regular modification
            // The CFG-based analysis will determine if it's truly unconditional
            interactions.modifications.push(calleeName);
          }
        }

        // Check if it's a functional update (applies to both deferred and non-deferred calls)
        if (
          node.arguments &&
          node.arguments.length > 0 &&
          (node.arguments[0].type === 'ArrowFunctionExpression' ||
            node.arguments[0].type === 'FunctionExpression')
        ) {
          interactions.functionalUpdates.push(calleeName);
        }
      }
    }

    // Check for member expressions (state reads)
    if (node.type === 'MemberExpression' && node.object && node.object.type === 'Identifier') {
      const objectName = node.object.name;
      if (stateNames.includes(objectName)) {
        interactions.reads.push(objectName);
      }
    }

    // Check for identifier references (state reads)
    if (node.type === 'Identifier' && stateNames.includes(node.name)) {
      // Only count as read if it's not being assigned to (simplified check)
      if (!parent || parent.type !== 'AssignmentExpression' || parent.left !== node) {
        interactions.reads.push(node.name);
      }
    }

    // Check for ref.current mutations (e.g., ref.current = value)
    if (
      node.type === 'AssignmentExpression' &&
      node.left &&
      node.left.type === 'MemberExpression' &&
      node.left.object &&
      node.left.object.type === 'Identifier' &&
      node.left.property &&
      node.left.property.type === 'Identifier' &&
      node.left.property.name === 'current' &&
      refVars.has(node.left.object.name)
    ) {
      const refName = node.left.object.name;
      const rightSide = node.right;

      // Check if the assigned value is a state variable
      let assignedValue: string | undefined;
      let usesStateValue = false;

      if (rightSide.type === 'Identifier') {
        assignedValue = rightSide.name;
        usesStateValue = stateNames.includes(rightSide.name);
      } else {
        // Check if any identifier in the right side is a state variable
        const checkForStateVars = (n: t.Node): boolean => {
          if (n.type === 'Identifier' && stateNames.includes(n.name)) {
            return true;
          }
          const indexable = n as unknown as Record<string, unknown>;
          for (const key of Object.keys(n)) {
            const val = indexable[key];
            if (Array.isArray(val)) {
              for (const child of val) {
                if (child && typeof child === 'object' && (child as { type?: string }).type) {
                  if (checkForStateVars(child as t.Node)) return true;
                }
              }
            } else if (val && typeof val === 'object' && (val as { type?: string }).type) {
              if (checkForStateVars(val as t.Node)) return true;
            }
          }
          return false;
        };
        usesStateValue = checkForStateVars(rightSide);
      }

      interactions.refMutations.push({
        refName,
        assignedValue,
        usesStateValue,
        line: node.loc?.start.line || 0,
      });
    }

    // Recursively visit all properties
    const indexableVisitNode = node as unknown as Record<string, unknown>;
    Object.keys(node).forEach((key) => {
      const value = indexableVisitNode[key];
      if (Array.isArray(value)) {
        value.forEach((child) => visitNode(child as t.Node | null | undefined, node));
      } else if (value && typeof value === 'object' && (value as { type?: string }).type) {
        visitNode(value as t.Node, node);
      }
    });

    ancestorStack.pop();
  }

  visitNode(hookBody);

  // Remove duplicates
  interactions.reads = [...new Set(interactions.reads)];
  interactions.modifications = [...new Set(interactions.modifications)];
  interactions.conditionalModifications = [...new Set(interactions.conditionalModifications)];
  interactions.functionalUpdates = [...new Set(interactions.functionalUpdates)];
  interactions.deferredModifications = [...new Set(interactions.deferredModifications)];

  return interactions;
}
