import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import './index.css'
import App from './App'

// Boots the React app into the Vite HTML shell under StrictMode for double-invoked dev checks.
// Arguments: none (uses #root from index.html).
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
