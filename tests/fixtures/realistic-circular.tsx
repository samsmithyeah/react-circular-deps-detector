import React, { useCallback, useEffect, useState } from 'react';

// This represents the type of circular dependency that might exist in real React apps
export const RealisticCircularExample: React.FC = () => {
  const [user, setUser] = useState(null);
  const [chats, setChats] = useState(new Set<string>());

  // Function that updates database
  const updateActiveChatsInDB = useCallback(
    async (chats: Set<string>) => {
      if (!user?.uid) return;
      // Simulate database update
      console.log('Updating chats in DB:', chats);
    },
    [user?.uid]
  );

  // Function that adds a chat and calls updateActiveChatsInDB
  const addActiveChat = useCallback(
    (chatId: string) => {
      setChats((prev) => {
        const updated = new Set(prev);
        updated.add(chatId);
        updateActiveChatsInDB(updated); // This creates a dependency
        return updated;
      });
    },
    [updateActiveChatsInDB] // Depends on updateActiveChatsInDB
  );

  // Function that might call addActiveChat
  const subscribeToUser = useCallback(
    (uid: string) => {
      // In a circular scenario, this might trigger addActiveChat
      addActiveChat(uid); // This creates another dependency
    },
    [addActiveChat] // Depends on addActiveChat
  );

  // Effect that depends on subscribeToUser
  useEffect(() => {
    if (user?.uid) {
      subscribeToUser(user.uid); // Uses subscribeToUser
    }
  }, [user?.uid, subscribeToUser]); // Depends on subscribeToUser

  // If subscribeToUser somehow triggered a state change that affected updateActiveChatsInDB's dependencies,
  // this could create a circular dependency chain:
  // useEffect -> subscribeToUser -> addActiveChat -> updateActiveChatsInDB -> [user?.uid change] -> useEffect

  return <div>Realistic circular dependency example</div>;
};
