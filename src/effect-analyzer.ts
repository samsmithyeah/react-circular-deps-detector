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

  // Track functions that are passed as arguments (not invoked)
  const functionsPassedAsArgs = new Set<string>();

  // Track CallExpression nodes that are async callback receivers
  const asyncCallbackNodes = new Set<t.Node>();

  // First pass: find all functions passed as arguments to known safe receivers
  // AND track async callback nodes (calls to setInterval, onSnapshot, etc. with inline callbacks)
  traverse(hookBody, {
    noScope: true,
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;
      let receivingFuncName: string | null = null;

      // Handle: addEventListener('click', handler)
      if (t.isIdentifier(node.callee)) {
        receivingFuncName = node.callee.name;
      }
      // Handle: element.addEventListener('click', handler) or window.addEventListener(...)
      else if (t.isMemberExpression(node.callee) && t.isIdentifier(node.callee.property)) {
        receivingFuncName = node.callee.property.name;
      }

      if (receivingFuncName && EVENT_LISTENER_METHODS.has(receivingFuncName)) {
        // Check each argument - if it's an identifier, it's passed as reference
        for (const arg of node.arguments) {
          if (t.isIdentifier(arg)) {
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
        for (const arg of node.arguments) {
          if (t.isArrowFunctionExpression(arg) || t.isFunctionExpression(arg)) {
            asyncCallbackNodes.add(arg);
          }
        }
      }
    },
  });

  // Helper: check if a path is inside an async callback
  function isInsideAsyncCallback(path: NodePath): boolean {
    return path.findParent((p) => asyncCallbackNodes.has(p.node)) !== null;
  }

  // Helper: get ancestor stack as array of nodes (for analyzeConditionalGuard)
  function getAncestorStack(path: NodePath): t.Node[] {
    const ancestors: t.Node[] = [];
    let current: NodePath | null = path;
    while (current) {
      ancestors.push(current.node);
      current = current.parentPath;
    }
    return ancestors;
  }

  // Helper: check if any identifier in a node references a state variable
  function nodeReferencesState(node: t.Node): boolean {
    let found = false;
    traverse(node, {
      noScope: true,
      Identifier(innerPath: NodePath<t.Identifier>) {
        if (stateNames.includes(innerPath.node.name) && innerPath.isReferencedIdentifier()) {
          found = true;
          innerPath.stop();
        }
      },
    });
    return found;
  }

  // Main traversal pass
  traverse(hookBody, {
    noScope: true,

    // Check for function calls (state setters)
    CallExpression(path: NodePath<t.CallExpression>) {
      const node = path.node;
      if (!t.isIdentifier(node.callee)) return;

      const calleeName = node.callee.name;
      if (!setterNames.includes(calleeName)) return;

      const stateVar = setterToState.get(calleeName);

      // Check if this modification is inside an async callback (deferred)
      if (isInsideAsyncCallback(path)) {
        interactions.deferredModifications.push(calleeName);
      } else {
        // Not deferred, so analyze for loop risks
        const guardAnalysis = analyzeConditionalGuard(
          node,
          getAncestorStack(path),
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
        node.arguments.length > 0 &&
        (t.isArrowFunctionExpression(node.arguments[0]) ||
          t.isFunctionExpression(node.arguments[0]))
      ) {
        interactions.functionalUpdates.push(calleeName);
      }
    },

    // Check for member expressions (state reads)
    MemberExpression(path: NodePath<t.MemberExpression>) {
      const node = path.node;
      if (t.isIdentifier(node.object) && stateNames.includes(node.object.name)) {
        interactions.reads.push(node.object.name);
      }
    },

    // Check for identifier references (state reads)
    Identifier(path: NodePath<t.Identifier>) {
      const node = path.node;
      if (!stateNames.includes(node.name)) return;

      // Only count as read if it's a reference (not a property key, etc.)
      if (!path.isReferencedIdentifier()) return;

      // Skip if this is the left side of an assignment
      const parent = path.parent;
      if (t.isAssignmentExpression(parent) && parent.left === node) return;

      interactions.reads.push(node.name);
    },

    // Check for ref.current mutations (e.g., ref.current = value)
    AssignmentExpression(path: NodePath<t.AssignmentExpression>) {
      const node = path.node;
      if (
        !t.isMemberExpression(node.left) ||
        !t.isIdentifier(node.left.object) ||
        !t.isIdentifier(node.left.property) ||
        node.left.property.name !== 'current' ||
        !refVars.has(node.left.object.name)
      ) {
        return;
      }

      const refName = node.left.object.name;
      const rightSide = node.right;

      // Check if the assigned value is a state variable
      let assignedValue: string | undefined;
      let usesStateValue = false;

      if (t.isIdentifier(rightSide)) {
        assignedValue = rightSide.name;
        usesStateValue = stateNames.includes(rightSide.name);
      } else {
        usesStateValue = nodeReferencesState(rightSide);
      }

      interactions.refMutations.push({
        refName,
        assignedValue,
        usesStateValue,
        line: node.loc?.start.line || 0,
      });
    },
  });

  // Remove duplicates
  interactions.reads = [...new Set(interactions.reads)];
  interactions.modifications = [...new Set(interactions.modifications)];
  interactions.conditionalModifications = [...new Set(interactions.conditionalModifications)];
  interactions.functionalUpdates = [...new Set(interactions.functionalUpdates)];
  interactions.deferredModifications = [...new Set(interactions.deferredModifications)];

  return interactions;
}
