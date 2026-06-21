import './app.css'
import App from './App.svelte'

// Always render the full app — the modal/standalone case uses #/settings
// as the default hash so Settings.svelte is the first thing the user sees.
if (!window.location.hash) {
  window.location.hash = '#/settings';
}

const app = new App({
  target: document.getElementById('app'),
})

export default app
