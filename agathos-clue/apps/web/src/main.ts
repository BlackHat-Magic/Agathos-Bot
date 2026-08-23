import { mount } from 'svelte';
import './styles/app.css';
import App from './App.svelte';
import { initTheme } from './lib/theme';
import { session } from './auth/standalone';
import { bootstrapAuth } from './auth/bootstrap';
import { bootstrapGameFromUrl } from './game/bootstrap';
import { error, gameId } from './game/stores';

initTheme();

const initialGameId = bootstrapGameFromUrl();
if (initialGameId !== null) gameId.set(initialGameId);

void bootstrapAuth()
  .then(value => session.set(value))
  .catch(cause => error.set(cause instanceof Error ? cause.message : 'Unable to load session'));

const app = mount(App, { target: document.getElementById('app')! });

export default app;
