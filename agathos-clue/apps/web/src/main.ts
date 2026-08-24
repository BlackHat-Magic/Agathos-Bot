import { mount } from 'svelte';
import './styles/app.css';
import App from './App.svelte';
import { initTheme } from './lib/theme';
import { session } from './auth/standalone';
import { bootstrapAuth, isEmbeddedContext } from './auth/bootstrap';
import { bootstrapGameFromUrl } from './game/bootstrap';
import { authPending, embeddedMode, error, gameId } from './game/stores';

initTheme();

embeddedMode.set(isEmbeddedContext());

const initialGameId = bootstrapGameFromUrl();
if (initialGameId !== null) gameId.set(initialGameId);

void bootstrapAuth()
  .then(value => {
    session.set(value);
    // Everyone in the same voice channel shares one Discord activity instance,
    // so its id is the shared room key when the URL did not pick a game.
    if (initialGameId === null && value !== null && 'instanceId' in value) {
      gameId.set(`clue-game:${value.instanceId}`);
    }
  })
  .catch(cause => error.set(cause instanceof Error ? cause.message : 'Unable to load session'))
  .finally(() => authPending.set(false));

const app = mount(App, { target: document.getElementById('app')! });

export default app;
