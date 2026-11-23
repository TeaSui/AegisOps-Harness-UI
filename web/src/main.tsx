import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import '@fontsource-variable/jetbrains-mono';
import './styles.css';
import { applyLook } from './stage';

applyLook();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
