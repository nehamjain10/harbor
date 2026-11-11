// Entry point. public/theme-boot.js has already set data-theme before first paint;
// the theme module keeps it in sync (System preference, theme-color meta).
import './theme.js';
import 'harbor:fonts';
import './styles/tokens.css';
import './styles/base.css';
import './styles/syntax.css';
import { render } from 'preact';
import { init } from './actions.js';
import { App } from './components/App.jsx';
// After App so the drag styles come after App.css.
import { installDrawerGestures } from './gestures.js';
import { startAttention } from './attention.js';
import { startInputLog } from './inputLog.js';
import { installTextPaste } from './lib/pasteText.js';

// Mobile keyboards shrink the visual viewport but not 100dvh on every browser;
// size the shell from visualViewport so the composer stays above the keyboard.
function trackViewportHeight() {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const fit = () => document.documentElement.style.setProperty('--app-height', viewport.height + 'px');
  viewport.addEventListener('resize', fit);
  fit();
}

trackViewportHeight();
render(<App />, document.getElementById('app'));
init();
startAttention();
installDrawerGestures();
startInputLog();
installTextPaste();
