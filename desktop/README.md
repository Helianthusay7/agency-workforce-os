# Agency Workforce OS desktop launcher

This is the first local-app phase. It does not require a cloud server.

What it does:

- builds the TypeScript app when needed
- starts the local Node service on 127.0.0.1:4173
- opens the workstation UI
- stores runtime data in data/state.local.json
- stores a local-only auth secret in data/auth.secret.local

Run from the repository:

```powershell
npm run desktop
```

Or double-click:

```text
desktop\AgencyWorkstation.cmd
```

Stop the hidden local service:

```powershell
npm run desktop:stop
```

This is intentionally not the final installer. The next phase can wrap the same UI in Tauri while keeping this local-first execution model.