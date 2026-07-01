// main.ts - the entry point: pull in the global styles, then mount the Svelte app onto <div id="app">.
import './app.css'
import App from './App.svelte'

const app = new App({ target: document.getElementById('app')! })
export default app
