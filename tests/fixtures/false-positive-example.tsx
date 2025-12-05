import React, { useState, useCallback } from 'react';

// This file contains patterns that LOOK like circular dependencies but aren't
// Should NOT be flagged as circular dependencies

function FalsePositiveExample() {
  const [user, setUser] = useState(null);

  // This has a local variable 'user' inside the function
  // but it's NOT the same as the 'user' state variable
  const getSenderName = useCallback(async (senderId: string) => {
    const users = await fetchUsers([senderId]);
    const user = users.find((u) => u.id === senderId); // Local variable
    return user ? user.name : 'Unknown';
  }, []); // No actual circular dependency

  // This uses imported functions - not circular
  const fetchMessages = useCallback(async () => {
    const response = await fetch('/api/messages');
    const data = await response.json();
    return data;
  }, []); // fetch is imported, not circular

  // This uses React hooks - not circular
  const handleSubmit = useCallback(() => {
    console.log('Submitting...');
    // Using React's built-in functions is not circular
    setUser((prev) => ({ ...prev, submitted: true }));
  }, []); // setUser is from useState, not circular

  return (
    <div>
      <h1>False Positive Test</h1>
      <button onClick={handleSubmit}>Submit</button>
    </div>
  );
}

// Mock function to simulate imported utility
async function fetchUsers(ids: string[]) {
  return ids.map((id) => ({ id, name: `User ${id}` }));
}

export default FalsePositiveExample;
