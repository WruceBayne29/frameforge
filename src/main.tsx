import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App3D from './ui3d/App3D';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');
createRoot(root).render(
  <StrictMode>
    <App3D />
  </StrictMode>,
);
