import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App.js'
import './styles/tokens.css'
import './styles/global.css'
import './styles/marketing.css'
import './styles/console.css'
import './styles/dashboard.css'
import 'react-calendar-heatmap/dist/styles.css'
// `highlight.js` ships theme CSS as plain stylesheets; the dark theme matches
// the console palette without extra tuning.
import 'highlight.js/styles/github-dark.css'

const container = document.getElementById('app')
if (!container) {
  throw new Error('Missing #app mount node')
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
