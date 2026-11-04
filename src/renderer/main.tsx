/**
 * Renderer entry point.
 *
 * Renders a boot screen that reports real environment facts from the main
 * process. This is deliberately minimal for milestone 1: it proves the IPC
 * bridge, the app:// protocol, the CSP and the theme tokens all work end to end
 * before any feature surface is built on top.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './app/App.js';
import './styles/app.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root element missing from index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>
);
