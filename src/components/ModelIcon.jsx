import { Aperture, Asterisk, Route, Waypoints } from 'lucide-preact';
import { providerGroup } from '../lib/models.js';

// Provider glyph: Claude, OpenAI, OpenRouter, or the gateway.
export function ModelIcon({ model, size = 16 }) {
  const group = providerGroup(model);
  if (group === 'Claude') return <Asterisk size={size} class="model-icon model-icon-claude" />;
  if (group === 'OpenAI') return <Aperture size={size} class="model-icon model-icon-openai" />;
  if (group === 'OpenRouter') return <Route size={size} class="model-icon model-icon-openrouter" />;
  return <Waypoints size={size} class="model-icon model-icon-gateway" />;
}
