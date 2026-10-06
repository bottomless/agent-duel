# Agent Duel renderer

This Expo project is the renderer packaged inside the Agent Duel Electron app.
Its browser target exists for local development, Playwright, and Chrome-based
QA; it is not deployed as a product.

Use the repository-level desktop launcher for normal work:

```bash
npm run dev:desktop
```

Run only the browser QA surface against the development daemon with:

```bash
npm run dev:app
```

The renderer connects to the local daemon over WebSocket. It never calls
OpenRouter or the control plane directly. Authentication requests pass through the local
daemon to the control plane.

Routes live under `app/`; application code lives under `src/`; Arena UI lives
under `src/arena/`. Read [../../docs/expo-router.md](../../docs/expo-router.md)
before changing startup or routes and [../../docs/development.md](../../docs/development.md)
for testing.

Set `EXPO_PUBLIC_ENABLE_AUDIO_DEBUG=1` before starting Expo to show the dictation
debug card. Pair it with the daemon's `STT_DEBUG_AUDIO_DIR` setting when raw
audio evidence is required.
