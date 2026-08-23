import { mount } from 'svelte';
import './styles/app.css';
import App from './App.svelte';
import { initTheme } from './lib/theme';
import { loadStandaloneSession, session } from './auth/standalone';
import { error } from './game/stores';

initTheme();

void loadStandaloneSession()
  .then(value => session.set(value))
  .catch(cause => error.set(cause instanceof Error ? cause.message : 'Unable to load session'));

const app = mount(App, { target: document.getElementById('app')! });

export default app;
