import React, { useEffect, useState } from 'react';
import { processUserIndirectly, processUserAndUpdate } from './test-indirect-utils';

// Component that calls imported function which updates state
export function IndirectUpdateComponent() {
  const [user, setUser] = useState({ id: 1, name: 'John', version: 0 });

  useEffect(() => {
    // This should create infinite loop:
    // user changes → effect runs → processUserIndirectly modifies user → user changes → repeat
    processUserIndirectly(user);
  }, [user]); 

  return <div>User: {user.name} v{user.version}</div>;
}

// Component that passes both data and setter to imported function
export function DirectPassComponent() {
  const [profile, setProfile] = useState({ id: 1, name: 'Jane', updated: false });

  useEffect(() => {
    // This pattern we already detect - passing setter directly
    processUserAndUpdate(profile, setProfile);
  }, [profile]);

  return <div>Profile: {profile.name}</div>;
}