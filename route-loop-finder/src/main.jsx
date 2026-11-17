import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Bundled fonts (no font server: the app also runs without internet).
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './utils/theme' // applies the saved appearance
import './index.css'
import './classic.css' // the plain style (Display options > Style)
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
