// The agent view a row is rendered in (AgentPanel.jsx provides its path; the main
// transcript has none), so an agent opened from inside one opens under it.
import { createContext } from 'preact';
import { useContext } from 'preact/hooks';
import { openAgent } from '../actions.js';

export const AgentScope = createContext(null);

// A function that opens an agent call's transcript in the side panel.
export function useOpenAgent() {
  const from = useContext(AgentScope);
  return (toolId) => openAgent(toolId, { from: from || [] });
}
