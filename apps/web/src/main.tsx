import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App.js'
import './styles/tokens.css'
import './styles/global.css'
import './styles/marketing.css'
import './styles/console.css'

const container = document.getElementById('app')
if (!container) {
  throw new Error('Missing #app mount node')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
