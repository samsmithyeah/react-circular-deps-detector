// Utility functions that update state in different ways

// Pattern 1: Function that uses a global reference to update state
// This is the pattern where the state setter is not passed as parameter
// but the function somehow has access to it (e.g., through closure, global state, etc.)
let globalStateSetter: ((user: any) => void) | null = null;

export function setGlobalStateSetter(setter: (user: any) => void) {
  globalStateSetter = setter;
}

export function processUserIndirectly(user: any) {
  // This modifies the user but doesn't receive the setter as parameter
  // Instead it uses a global reference or some other mechanism
  if (globalStateSetter) {
    globalStateSetter({ ...user, version: user.version + 1, lastProcessed: new Date() });
  }
}

// Pattern 2: Function that accepts both data and setter (this we already detect)
export function processUserAndUpdate(user: any, setUser?: (user: any) => void) {
  if (setUser) {
    setUser({ ...user, version: user.version + 1, updated: true });
  } else {
    // Fallback to global setter
    if (globalStateSetter) {
      globalStateSetter({ ...user, version: user.version + 1, lastProcessed: new Date() });
    }
  }
}

// Pattern 3: Function that triggers a side effect that eventually updates state
// (This would be very hard to detect statically)
export function triggerAsyncUpdate(user: any) {
  // This could dispatch an event, make an API call, or trigger some other mechanism
  // that eventually leads to state update, but it's not directly traceable
  setTimeout(() => {
    if (globalStateSetter) {
      globalStateSetter({ ...user, asyncUpdated: true });
    }
  }, 100);
}